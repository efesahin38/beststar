const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.get("/debug-chrome", (req, res) => {
  const fs = require("fs");
  const paths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome"
  ];
  const found = paths.filter(p => fs.existsSync(p));
  res.json({ found, env: process.env.PUPPETEER_EXECUTABLE_PATH });
});

app.post("/scrape", async (req, res) => {
  const business = req.body.business;
  if (!business) return res.json({ error: "İşletme adı gerekli." });

  let browser;
  try {
    console.log(`🔎 "${business}" aranıyor...`);

    // Render.com 512MB optimizasyonu
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1024,768",
        "--single-process",
        "--no-zygote",
        "--disable-accelerated-2d-canvas",
        "--memory-pressure-off",
        "--max-old-space-size=384", // 512MB'nin %75'i
        "--lang=tr-TR,tr",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      ],
      dumpio: false
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(120000);
    await page.setViewport({ width: 1024, height: 768 });

    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr'] });
    });

    // Cookie consent bypass
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+cb.20210720-07-p0.tr+FX+410',
      domain: '.google.com',
      path: '/',
      expires: Date.now() / 1000 + 31536000
    });

    // 1. Google Maps'e git
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await delay(8000);

    // 2. Cookie consent kontrolü
    let currentUrl = page.url();
    if (currentUrl.includes('consent.google.com')) {
      console.log("🍪 Consent bypass...");
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const acceptBtn = buttons.find(b => 
          (b.textContent || '').toLowerCase().match(/accept|kabul|akzeptieren|agree|alle/)
        );
        if (acceptBtn) acceptBtn.click();
      });
      await delay(3000);
      
      if (page.url().includes('consent.google.com')) {
        await page.evaluate(() => document.querySelector('form')?.submit());
        await delay(3000);
      }
      
      if (!page.url().includes('/maps/')) {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
        await delay(6000);
      }
    }

    console.log("✅ Maps sayfasındayız");

    // 3. İşletme kartını bul - GÜVENİLİR YÖNTEM
    console.log("🎯 İşletme kartı aranıyor...");
    let placeFound = false;

    // Önce kesin place link bekle (büyük işletmeler için kritik)
    try {
      console.log("⏳ Place link bekleniyor (max 60 saniye)...");
      await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 60000 });
      
      const placeLinks = await page.$$('a[href*="/maps/place/"]');
      console.log(`✅ ${placeLinks.length} place link bulundu`);

      if (placeLinks.length > 0) {
        // İlk 3 linki kontrol et, en iyi eşleşeni bul
        const businessLower = business.toLowerCase();
        let bestMatch = null;
        let bestScore = 0;

        for (let i = 0; i < Math.min(3, placeLinks.length); i++) {
          const linkInfo = await page.evaluate(el => ({
            text: (el.textContent || '').trim().toLowerCase(),
            href: el.href
          }), placeLinks[i]);

          // Basit eşleşme skoru
          const words = businessLower.split(' ').filter(w => w.length > 2);
          let score = 0;
          words.forEach(word => {
            if (linkInfo.text.includes(word)) score++;
          });

          console.log(`🔍 Link ${i}: "${linkInfo.text.substring(0, 40)}" - Skor: ${score}`);

          if (score > bestScore) {
            bestScore = score;
            bestMatch = i;
          }
        }

        // En iyi eşleşeni tıkla
        const linkToClick = bestMatch !== null ? placeLinks[bestMatch] : placeLinks[0];
        await linkToClick.click();
        console.log(`✅ Link tıklandı (index: ${bestMatch !== null ? bestMatch : 0})`);
        placeFound = true;
        await delay(5000);

        // Navigation bekle
        await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
        await delay(3000);
      }
    } catch (e) {
      console.log("⚠️ Place link bulunamadı:", e.message);
    }

    // Alternatif: Direkt URL'ye git
    if (!placeFound) {
      console.log("🔄 Direkt URL stratejisi...");
      const placeUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/maps/place/"]');
        return link ? link.href : null;
      });
      
      if (placeUrl) {
        console.log(`🔗 URL'ye gidiliyor: ${placeUrl.substring(0, 80)}...`);
        await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        placeFound = true;
        await delay(6000);
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      return res.json({ 
        error: "İşletme kartı bulunamadı. İşletme adını daha spesifik girin (örn: şehir ekleyin).",
        suggestion: "Örnek: 'İşletme Adı + Şehir'"
      });
    }

    console.log("🎉 İşletme kartı başarıyla açıldı!");

    // 4. İşletme bilgilerini al
    console.log("📋 İşletme bilgileri alınıyor...");
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 15000 }).catch(() => {});
    
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
      
      let address = 'Adres bulunamadı';
      const addressSelectors = [
        'button[data-item-id*="address"]',
        'div[aria-label*="Adres"]',
        'button[data-tooltip*="Adres"]',
        '.rogA2c',
        '[data-item-id="address"]'
      ];
      
      for (const sel of addressSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText) {
          address = el.innerText.trim();
          break;
        }
      }
      
      return { name, address };
    });
    
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // 5. Yorumlar sekmesini aç
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(2000);
    
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button.hh2c6',
      'button[data-tab-index="1"]',
      'div.F7nice button',
      'button.HHrUdb'
    ];
    
    let reviewsOpened = false;
    for (const selector of reviewButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        console.log(`🎯 Yorum butonu: ${selector}`);
        await btn.click();
        reviewsOpened = true;
        await delay(4000);
        break;
      }
    }

    if (!reviewsOpened) {
      console.log("❌ Yorumlar açılamadı!");
      return res.json({ error: "Yorumlar sekmesi açılamadı." });
    }

    // 6. Sıralama - En düşük puanlı
    console.log("⭐ Sıralama ayarlanıyor...");
    await delay(1500);
    
    try {
      const sortBtn = await page.$('button[aria-label*="sırala" i], button[aria-label*="sort" i]');
      if (sortBtn) {
        await sortBtn.click();
        await delay(1000);
        
        // En düşük puanlı seç
        const lowestOption = await page.$('[data-index="1"], div[role="menuitemradio"]:nth-child(2)');
        if (lowestOption) {
          await lowestOption.click();
          console.log("✅ En düşük puanlı seçildi");
          await delay(2500);
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı");
    }

    // 7. AKILLI SCROLL - 3 yıldız bulunca dur
    console.log("📜 Akıllı scroll başlatılıyor...");
    
    let threeStarFound = false;
    let scrollCount = 0;
    let lastReviewCount = 0;
    let stableCount = 0;
    const MAX_SCROLL = 150; // Güvenlik limiti
    
    for (let i = 0; i < MAX_SCROLL; i++) {
      const { reviews, hasThreeStar } = await page.evaluate(() => {
        const container = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
                          document.querySelector('.m6QErb') ||
                          document.querySelector('div[role="region"]');
        
        if (!container) return { reviews: 0, hasThreeStar: false };
        
        container.scrollTop = container.scrollHeight;
        
        // Yorum sayısı
        const reviewElements = document.querySelectorAll('[data-review-id], .jftiEf');
        
        // 3 yıldız var mı kontrol
        let hasThree = false;
        reviewElements.forEach(card => {
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match && parseInt(match[1]) === 3) hasThree = true;
          }
        });
        
        return { reviews: reviewElements.length, hasThreeStar: hasThree };
      });
      
      scrollCount++;
      
      // 3 yıldız bulundu mu?
      if (hasThreeStar && !threeStarFound) {
        console.log("⭐ 3 yıldızlı yorum bulundu! 1 scroll daha yapılacak...");
        threeStarFound = true;
      }
      
      // 3 yıldız bulunduysa ve 1 scroll daha yaptıysa DUR
      if (threeStarFound) {
        console.log("🛑 3 yıldız sonrası 1 scroll tamamlandı, durduruluyor");
        break;
      }
      
      // Yorum sayısı değişmedi mi?
      if (reviews === lastReviewCount) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      lastReviewCount = reviews;
      
      // Log
      if (i % 15 === 0) {
        console.log(`📊 Scroll ${i} | Yorum: ${reviews} | Sabit: ${stableCount}`);
      }
      
      // Yorum artmıyorsa ve en az 30 yorum varsa dur
      if (stableCount >= 8 && reviews > 30) {
        console.log("🛑 Yorum sayısı artmıyor, durduruluyor");
        break;
      }
      
      await delay(700 + Math.random() * 300);
    }
    
    console.log(`✅ Scroll tamamlandı (${scrollCount} iterasyon) | Son yorum: ${lastReviewCount}`);
    await delay(2000);

    // 8. Yorumları çek - SADECE 1 ve 2 yıldız
    console.log("🔍 1 ve 2 yıldızlı yorumlar parse ediliyor...");
    
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenHashes = new Set();
      
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id], .jftiEf'));
      
      // Önce "daha fazla" butonlarını tıkla (sadece 1-2 yıldızlılar için)
      reviewElements.forEach(card => {
        // Yıldızı kontrol et
        const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
        if (!starEl) return;
        
        const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
        if (!match) return;
        const rating = parseInt(match[1]);
        
        // Sadece 1-2 yıldız için expand
        if (rating <= 2) {
          const expandBtns = card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe');
          expandBtns.forEach(btn => {
            if (btn.offsetHeight > 0) btn.click();
          });
        }
      });
      
      // Parse
      reviewElements.forEach(card => {
        try {
          // Yıldız
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          
          // SADECE 1 ve 2 yıldız
          if (!rating || rating > 2) return;
          
          // Metin
          let text = '';
          const textEl = card.querySelector('.wiI7pd, span[data-expandable-section], .MyEned');
          if (textEl) text = textEl.textContent?.trim() || '';
          
          // Yazar
          let author = 'Anonim';
          const authorEl = card.querySelector('.d4r55');
          if (authorEl) {
            author = authorEl.textContent?.trim().split('·')[0].trim() || 'Anonim';
          }
          
          // Tarih
          let date = '';
          const dateEl = card.querySelector('.rsqaWe');
          if (dateEl) date = dateEl.textContent?.trim() || '';
          
          // Hash ile unique
          const hash = `${rating}|${author}|${text.substring(0, 50)}`;
          if (seenHashes.has(hash)) return;
          seenHashes.add(hash);
          
          results.push({ 
            rating, 
            text, 
            author, 
            date,
            hasReview: text.length > 0 
          });
        } catch (e) {}
      });
      
      return results;
    });

    console.log(`✅ Toplam ${reviews.length} adet 1-2 yıldızlı yorum çekildi`);

    // İstatistikler
    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);

    res.json({
      success: true,
      name: businessInfo.name,
      address: businessInfo.address,
      "1_star": oneStar.length,
      "2_star": twoStar.length,
      "1_star_with_text": oneStar.filter(r => r.hasReview).length,
      "1_star_without_text": oneStar.filter(r => !r.hasReview).length,
      "2_star_with_text": twoStar.filter(r => r.hasReview).length,
      "2_star_without_text": twoStar.filter(r => !r.hasReview).length,
      reviews_1_star: oneStar,
      reviews_2_star: twoStar,
      total_reviews_scraped: reviews.length
    });

  } catch (err) {
    console.error("❌ HATA:", err.message);
    res.json({ success: false, error: err.message });
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 Browser kapatıldı");
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
  console.log(`💡 Test: http://localhost:${PORT}/health`);
  console.log(`💡 Debug: http://localhost:${PORT}/debug-chrome`);
});
