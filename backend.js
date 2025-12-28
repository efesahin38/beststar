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

    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800",
        "--single-process",
        "--no-zygote",
        "--max-old-space-size=384",
        "--lang=tr-TR,tr",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      ],
      dumpio: false
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(120000);
    await page.setViewport({ width: 1280, height: 800 });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr'] });
    });

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

    // 2. Cookie consent
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

    // 3. Sayfa analizi
    console.log("🔍 Sayfa yapısı analiz ediliyor...");
    const pageAnalysis = await page.evaluate(() => {
      return {
        url: window.location.href,
        placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
        hfpxzc: document.querySelectorAll('.hfpxzc').length,
        cards: document.querySelectorAll('div[role="article"]').length
      };
    });
    console.log("📊 Sayfa Analizi:", JSON.stringify(pageAnalysis, null, 2));

    // 4. İşletme kartını bul - ÇOKLU STRATEJİ
    console.log("🎯 İşletme kartı aranıyor...");
    let placeFound = false;

    // STRATEJİ 1: Place link bekle ve tıkla (kısa timeout)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 1: Place link (20 saniye)...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        console.log(`✅ ${placeLinks.length} place link bulundu`);
        
        if (placeLinks.length > 0) {
          // İlk 3 linki kontrol et
          const businessLower = business.toLowerCase();
          let bestMatch = 0;
          let bestScore = 0;

          for (let i = 0; i < Math.min(3, placeLinks.length); i++) {
            const linkText = await page.evaluate(el => 
              (el.textContent || '').trim().toLowerCase().substring(0, 50), 
              placeLinks[i]
            );
            
            const words = businessLower.split(' ').filter(w => w.length > 2);
            let score = words.filter(word => linkText.includes(word)).length;
            
            if (score > bestScore) {
              bestScore = score;
              bestMatch = i;
            }
          }

          console.log(`📌 En iyi eşleşme: index ${bestMatch}`);
          await placeLinks[bestMatch].click();
          console.log("✅ Link tıklandı");
          placeFound = true;
          await delay(4000);
          await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
          await delay(3000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 1 başarısız");
      }
    }

    // STRATEJİ 2: Kart selectors ile tıkla
    if (!placeFound) {
      try {
        console.log("📍 Strateji 2: Kart selectors...");
        const cardSelectors = [
          '.hfpxzc',
          '.Nv2PK',
          'div[role="article"]',
          '.qBF1Pd',
          'a.hfpxzc'
        ];
        
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          if (cards.length > 0) {
            console.log(`✅ ${selector}: ${cards.length} kart bulundu`);
            const cardText = await page.evaluate(el => 
              (el.textContent || '').trim().toLowerCase().substring(0, 50), 
              cards[0]
            );
            
            if (cardText.includes(business.toLowerCase().substring(0, 8))) {
              await cards[0].click();
              console.log(`✅ Kart tıklandı (${selector})`);
              placeFound = true;
              await delay(4000);
              break;
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 2 başarısız");
      }
    }

    // STRATEJİ 3: Direkt URL'ye git
    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Direkt URL...");
        const placeUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="/maps/place/"]');
          return link ? link.href : null;
        });
        
        if (placeUrl) {
          console.log(`🔗 URL'ye gidiliyor...`);
          await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          placeFound = true;
          await delay(6000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // STRATEJİ 4: Arama çubuğuna tekrar yaz
    if (!placeFound) {
      try {
        console.log("📍 Strateji 4: Arama çubuğu reset...");
        const searchInput = await page.$('input#searchboxinput');
        if (searchInput) {
          await searchInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await delay(500);
          await searchInput.type(business, { delay: 100 });
          await page.keyboard.press('Enter');
          await delay(8000);
          
          await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
          const placeLinks = await page.$$('a[href*="/maps/place/"]');
          if (placeLinks.length > 0) {
            await placeLinks[0].click();
            placeFound = true;
            await delay(4000);
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 4 başarısız");
      }
    }

    // STRATEJİ 5: Koordinat tıklama
    if (!placeFound) {
      try {
        console.log("📍 Strateji 5: Koordinat tıklama...");
        await page.mouse.click(350, 350);
        await delay(4000);
        if (page.url().includes('/maps/place/')) {
          console.log("✅ Koordinat başarılı");
          placeFound = true;
        }
      } catch (e) {
        console.log("⚠️ Strateji 5 başarısız");
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      return res.json({ 
        error: "İşletme bulunamadı. İşletme adını şehir ile birlikte deneyin.",
        debug: pageAnalysis
      });
    }

    console.log("🎉 İşletme kartı açıldı!");

    // 5. İşletme bilgilerini al
    console.log("📋 İşletme bilgileri alınıyor...");
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 15000 }).catch(() => {});
    
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
      
      let address = 'Adres bulunamadı';
      const addressSelectors = [
        'button[data-item-id*="address"]',
        'div[aria-label*="Adres"]',
        '.rogA2c',
        '[data-item-id="address"]',
        'button[data-tooltip*="address" i]'
      ];
      
      for (const sel of addressSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 5) {
          address = el.innerText.trim();
          break;
        }
      }
      
      return { name, address };
    });
    
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // 6. Yorumlar sekmesini aç
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(2000);
    
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button.hh2c6',
      'button[data-tab-index="1"]',
      'div.F7nice button',
      'button.HHrUdb',
      'button[aria-label*="Bewertung" i]'
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

    // 7. Sıralama - En düşük puanlı
    console.log("⭐ Sıralama ayarlanıyor...");
    await delay(1500);
    
    try {
      const sortBtn = await page.$('button[aria-label*="sırala" i], button[aria-label*="sort" i], button[aria-label*="sortier" i]');
      if (sortBtn) {
        await sortBtn.click();
        await delay(1000);
        
        const lowestSelectors = [
          '[data-index="1"]',
          'div[role="menuitemradio"]:nth-child(2)',
          '[data-value="qualityScore"]'
        ];
        
        for (const sel of lowestSelectors) {
          const option = await page.$(sel);
          if (option) {
            await option.click();
            console.log("✅ En düşük puanlı seçildi");
            await delay(2500);
            break;
          }
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı");
    }

    // 8. GÜÇLENDİRİLMİŞ SCROLL - TÜM 1-2 YILDIZLARI ÇEK
    console.log("📜 Güçlendirilmiş scroll başlatılıyor (TÜM 1-2 yıldızları çekecek)...");
    
    let oneTwoStarCount = 0;
    let lastOneTwoStarCount = 0;
    let stableStreak = 0;
    let scrollCount = 0;
    let threeStarAppeared = false;
    let extraScrollAfterThree = 0;
    const MAX_SCROLL = 250; // Güvenlik limiti artırıldı
    const STABLE_LIMIT = 15; // Yüksek eşik - gerçekten bitene kadar devam
    
    for (let i = 0; i < MAX_SCROLL; i++) {
      const { totalReviews, oneTwoStars, hasThreeStar } = await page.evaluate(() => {
        const container = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
                          document.querySelector('.m6QErb') ||
                          document.querySelector('div[role="region"]');
        
        if (!container) return { totalReviews: 0, oneTwoStars: 0, hasThreeStar: false };
        
        container.scrollTop = container.scrollHeight;
        
        const reviewElements = document.querySelectorAll('[data-review-id], .jftiEf');
        
        let oneTwoCount = 0;
        let hasThree = false;
        
        reviewElements.forEach(card => {
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) {
              const rating = parseInt(match[1]);
              if (rating === 1 || rating === 2) oneTwoCount++;
              if (rating === 3) hasThree = true;
            }
          }
        });
        
        return { 
          totalReviews: reviewElements.length, 
          oneTwoStars: oneTwoCount,
          hasThreeStar: hasThree 
        };
      });
      
      scrollCount++;
      oneTwoStarCount = oneTwoStars;
      
      // 3 yıldız görünüyor mu?
      if (hasThreeStar && !threeStarAppeared) {
        console.log("⭐ 3 yıldızlı yorum görüldü! Ama devam ediliyor (1-2 yıldızlar bitene kadar)...");
        threeStarAppeared = true;
      }
      
      if (threeStarAppeared) {
        extraScrollAfterThree++;
      }
      
      // 1-2 yıldız sayısı değişti mi?
      if (oneTwoStarCount === lastOneTwoStarCount) {
        stableStreak++;
      } else {
        stableStreak = 0;
      }
      lastOneTwoStarCount = oneTwoStarCount;
      
      // Log (her 10 scrollda)
      if (i % 10 === 0 || stableStreak > 0) {
        console.log(`📊 Scroll ${i} | Toplam Yorum: ${totalReviews} | 1-2⭐: ${oneTwoStarCount} | Sabit: ${stableStreak}`);
      }
      
      // DUR KRİTERLERİ:
      // 1. 1-2 yıldız sayısı 15 scrolldan fazla değişmedi VE en az 10 yorum var
      if (stableStreak >= STABLE_LIMIT && oneTwoStarCount >= 10) {
        console.log("🛑 1-2 yıldızlı yorumlar artık çıkmıyor, tamamlandı!");
        break;
      }
      
      // 2. 3 yıldız görüldü VE 25 scroll daha yapıldı VE 1-2 yıldız artmıyor
      if (threeStarAppeared && extraScrollAfterThree >= 25 && stableStreak >= 8) {
        console.log("🛑 3 yıldız sonrası 25 scroll yapıldı ve 1-2 yıldız artmıyor, durduruluyor");
        break;
      }
      
      // 3. Çok az yorum varsa ve 12 scrolldan fazla değişmedi
      if (oneTwoStarCount < 5 && stableStreak >= 12) {
        console.log("🛑 Çok az 1-2 yıldızlı yorum var ve artmıyor");
        break;
      }
      
      await delay(600 + Math.random() * 250);
    }
    
    console.log(`✅ Scroll tamamlandı (${scrollCount} iterasyon) | Son 1-2⭐ sayısı: ${oneTwoStarCount}`);
    console.log(`📈 Scroll detay: 3⭐ görüldü mü: ${threeStarAppeared ? 'EVET' : 'HAYIR'} | Sonrası scroll: ${extraScrollAfterThree}`);
    await delay(2500);

    // 9. Yorumları çek - SADECE 1 ve 2 yıldız, GELİŞMİŞ PARSE
    console.log("🔍 1 ve 2 yıldızlı yorumlar parse ediliyor...");
    
    // Önce tüm expand butonlarını tıkla
    await page.evaluate(() => {
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id], .jftiEf'));
      reviewElements.forEach(card => {
        const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
        if (!starEl) return;
        
        const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
        if (!match) return;
        const rating = parseInt(match[1]);
        
        if (rating <= 2) {
          const expandBtns = card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe, button[jsaction*="review.expandReview"]');
          expandBtns.forEach(btn => {
            try {
              if (btn.offsetHeight > 0 && btn.offsetWidth > 0) btn.click();
            } catch (e) {}
          });
        }
      });
    });
    
    await delay(1500);
    
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenHashes = new Set();
      
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id], .jftiEf, div[jsaction*="pane.review"]'));
      
      console.log(`Parse: ${reviewElements.length} yorum kartı bulundu`);
      
      reviewElements.forEach((card, idx) => {
        try {
          // Yıldız
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i], [aria-label*="Stern" i]');
          if (starEl) {
            const ariaLabel = starEl.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          
          // SADECE 1 ve 2 yıldız
          if (!rating || rating > 2) return;
          
          // Metin - Birden fazla selector dene
          let text = '';
          const textSelectors = [
            '.wiI7pd',
            'span[data-expandable-section]',
            '.MyEned',
            '[jsaction*="pane.review.expandReview"]',
            'span[jsan]'
          ];
          
          for (const sel of textSelectors) {
            const textEl = card.querySelector(sel);
            if (textEl && textEl.textContent) {
              text = textEl.textContent.trim();
              if (text.length > 10) break; // Yeterince uzun metin bulundu
            }
          }
          
          // Yazar
          let author = 'Anonim';
          const authorSelectors = ['.d4r55', '.WNxzHc', 'button.WEBjve'];
          for (const sel of authorSelectors) {
            const authorEl = card.querySelector(sel);
            if (authorEl && authorEl.textContent) {
              author = authorEl.textContent.trim().split('·')[0].trim();
              if (author.length > 0) break;
            }
          }
          
          // Tarih
          let date = '';
          const dateSelectors = ['.rsqaWe', 'span.rsqaWe'];
          for (const sel of dateSelectors) {
            const dateEl = card.querySelector(sel);
            if (dateEl && dateEl.textContent) {
              date = dateEl.textContent.trim();
              break;
            }
          }
          
          // Unique hash - rating + author + text başlangıcı
          const hash = `${rating}|${author}|${text.substring(0, 80)}`;
          if (seenHashes.has(hash)) return;
          seenHashes.add(hash);
          
          results.push({ 
            rating, 
            text, 
            author, 
            date,
            hasReview: text.length > 0 
          });
        } catch (e) {
          console.error(`Parse hatası (kart ${idx}):`, e.message);
        }
      });
      
      console.log(`Parse tamamlandı: ${results.length} benzersiz 1-2⭐ yorum`);
      return results;
    });

    console.log(`✅ Toplam ${reviews.length} adet 1-2 yıldızlı yorum çekildi`);

    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);

    console.log(`📊 Detay: 1⭐ ${oneStar.length} | 2⭐ ${twoStar.length}`);
    console.log(`📝 Metin var: 1⭐ ${oneStar.filter(r => r.hasReview).length} | 2⭐ ${twoStar.filter(r => r.hasReview).length}`);

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
      total_reviews_scraped: reviews.length,
      scroll_iterations: scrollCount
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
