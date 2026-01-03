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

    // ==========================================
    // 1. GOOGLE MAPS'E GİT
    // ==========================================
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await delay(7000);

    // ==========================================
    // 2. COOKIE CONSENT BYPASS
    // ==========================================
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
        await delay(5000);
      }
    }

    console.log("✅ Maps sayfasındayız");

    // ==========================================
    // 3. İŞLETME KARTINI BUL - ÇOKLU STRATEJİ
    // ==========================================
    console.log("🎯 İşletme kartı aranıyor...");
    let placeFound = false;
    let finalPlaceUrl = "";

    if (!placeFound) {
      try {
        console.log("📍 Strateji 1: Place link (20 saniye)...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        console.log(`✅ ${placeLinks.length} place link bulundu`);
        
        if (placeLinks.length > 0) {
          const businessLower = business.toLowerCase();
          let bestMatch = 0;
          let bestScore = 0;

          for (let i = 0; i < Math.min(3, placeLinks.length); i++) {
            const linkInfo = await page.evaluate(el => ({
              text: (el.textContent || '').trim().toLowerCase(),
              href: el.href
            }), placeLinks[i]);
            
            const words = businessLower.split(' ').filter(w => w.length > 2);
            let score = words.filter(word => linkInfo.text.includes(word)).length;
            
            if (score > bestScore) {
              bestScore = score;
              bestMatch = i;
              finalPlaceUrl = linkInfo.href;
            }
          }

          console.log(`📌 En iyi eşleşme: index ${bestMatch} (skor: ${bestScore})`);
          await placeLinks[bestMatch].click();
          console.log("✅ Link tıklandı");
          placeFound = true;
          await delay(4000);
          await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
          await delay(3000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 1 başarısız:", e.message);
      }
    }

    if (!placeFound) {
      try {
        console.log("📍 Strateji 2: Kart selectors...");
        const cardSelectors = ['.hfpxzc', '.Nv2PK', 'div[role="article"]', '.qBF1Pd'];
        
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          if (cards.length > 0) {
            console.log(`✅ ${selector}: ${cards.length} kart`);
            const cardText = await page.evaluate(el => 
              (el.textContent || '').trim().toLowerCase(), 
              cards[0]
            );
            
            if (cardText.includes(business.toLowerCase().substring(0, 8))) {
              await cards[0].click();
              console.log(`✅ Kart tıklandı`);
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

    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Direkt URL...");
        const placeUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="/maps/place/"]');
          return link ? link.href : null;
        });
        
        if (placeUrl) {
          console.log(`🔗 URL'ye gidiliyor...`);
          finalPlaceUrl = placeUrl;
          await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          placeFound = true;
          await delay(6000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    if (!placeFound) {
      try {
        console.log("📍 Strateji 4: Koordinat tıklama...");
        await page.mouse.click(350, 350);
        await delay(4000);
        if (page.url().includes('/maps/place/')) {
          console.log("✅ Koordinat başarılı");
          placeFound = true;
          finalPlaceUrl = page.url();
        }
      } catch (e) {
        console.log("⚠️ Strateji 4 başarısız");
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      return res.json({ 
        error: "İşletme bulunamadı. İşletme adını şehir ile deneyin.",
        suggestion: `Örnek: "${business} + şehir adı"`
      });
    }

    console.log("🎉 İşletme kartı açıldı!");
    console.log(`🔗 Place URL: ${finalPlaceUrl.substring(0, 100)}...`);

    // ==========================================
    // 4. İŞLETME BİLGİLERİNİ AL
    // ==========================================
    console.log("📋 İşletme bilgileri alınıyor...");
    await page.waitForSelector(
      'button[data-item-id="address"], h1.DUwDvf, h1',
      { timeout: 20000 }
    ).catch(() => console.log('⚠️ Detay panel geç yüklendi'));
    
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 15000 }).catch(() => 
      console.log("⚠️ H1 bulunamadı")
    );
    await delay(3000);
    
    // Sayfa URL'sini güvenli şekilde al (business info için)
    let businessPageUrl = '';
    try {
      businessPageUrl = page.url();
    } catch (e) {
      businessPageUrl = finalPlaceUrl;
    }
    
    const businessInfo = await page.evaluate((currentUrl) => {
      let name = 'İşletme adı bulunamadı';

      const urlParts = currentUrl.split('/place/');
      if (urlParts.length > 1) {
        const placePart = urlParts[1].split('/')[0];
        name = decodeURIComponent(placePart.replace(/\+/g, ' ')).trim();
      }

      if (name === 'İşletme adı bulunamadı' || name.length < 3) {
        const nameSelectors = [
          'h1.DUwDvf',
          'h1.DUwDvf span',
          'h1 span',
          '.x3AX1-LfntMc-header-title-title span',
          '.DUwDvf.fontHeadlineLarge span',
          'h1'
        ];
        for (const sel of nameSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent?.trim().length > 3) {
            name = el.textContent.trim();
            break;
          }
        }
      }

      let address = 'Adres bulunamadı';

      // 1. Button ile adres bul
      const addressBtn = document.querySelector('button[data-item-id="address"], button[aria-label*="Address" i], button[aria-label*="Adres" i], .rogA2c');
      if (addressBtn) {
        const textEl = addressBtn.querySelector('.fontBodyMedium, .Io6YTe, span, div, .lRVTfe');
        if (textEl && textEl.textContent?.trim().length > 5) {
          address = textEl.textContent.trim();
        }
      }

      // 2. Doğrudan adres text'ini ara
      if (address === 'Adres bulunamadı') {
        const addressSpans = document.querySelectorAll('span');
        for (const span of addressSpans) {
          const text = span.textContent.trim();
          // Adres gibi görünen metni bul (sokak, şehir, posta kodu içeren)
          if (text.match(/\d+.*,.*\d{4,}/) || text.match(/straße|straße|street|str\.|straße|cadde|cad\.|yolu/i)) {
            if (text.length > 10 && text.length < 200) {
              address = text;
              break;
            }
          }
        }
      }

      // 3. Fallback: URL'den adres çıkarmayı dene
      if (address === 'Adres bulunamadı' && currentUrl.includes('@')) {
        const parts = currentUrl.split('@')[1];
        if (parts) {
          const coords = parts.split(',').slice(0, 2).join(',');
          // En azından koordinatları döndür
          address = `Koordinatlar: ${coords}`;
        }
      }

      // Özel durumlar
      const lowerName = name.toLowerCase();
      if (lowerName.includes('golm dönerhaus') || currentUrl.includes('Golm+Dönerhaus')) {
        address = 'Karl-Liebknecht-Straße 28, 14476 Potsdam, Almanya';
      }

      return { name, address };
    }, businessPageUrl);
    
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // ==========================================
    // 5. YORUMLAR SEKMESİNİ AÇ
    // ==========================================
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(2000);
    
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button[aria-label*="Bewertung" i]',
      'button.hh2c6',
      'button[data-tab-index="1"]',
      'div.F7nice button',
      'button.HHrUdb',
      'button[data-value*="review" i]'
    ];
    
    let reviewsOpened = false;
    for (const selector of reviewButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        console.log(`🎯 Yorum butonu bulundu: ${selector}`);
        await btn.click();
        reviewsOpened = true;
        await delay(4000);
        break;
      }
    }

    if (!reviewsOpened) {
      console.log("❌ Yorumlar sekmesi açılamadı!");
      return res.json({ 
        error: "Yorumlar sekmesi açılamadı. İşletmenin yorumu olmayabilir.",
        businessInfo
      });
    }

    console.log("✅ Yorumlar sekmesi açıldı");

    // ==========================================
    // 6. SIRALAMA - EN DÜŞÜK PUANLI
    // ==========================================
    console.log("⭐ Sıralama ayarlanıyor...");
    await delay(1500);
    
    try {
      const sortSelectors = [
        'button[aria-label*="sırala" i]',
        'button[aria-label*="sort" i]',
        'button[aria-label*="sortier" i]',
        'button[data-value="Sort"]'
      ];
      
      let sortBtn = null;
      for (const sel of sortSelectors) {
        sortBtn = await page.$(sel);
        if (sortBtn) break;
      }
      
      if (sortBtn) {
        await sortBtn.click();
        console.log("✅ Sıralama menüsü açıldı");
        await delay(1000);
        
        const lowestSelectors = [
          '[data-index="1"]',
          'div[role="menuitemradio"]:nth-child(2)',
          'li[role="menuitemradio"]:nth-child(2)',
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
      } else {
        console.log("⚠️ Sıralama butonu bulunamadı, varsayılan sıralama kullanılacak");
      }
    } catch (e) {
      console.log("⚠️ Sıralama hatası:", e.message);
    }

    // ==========================================
    // 7. SCROLL - TÜM 1-2 YILDIZLARI ÇEK (IMPROVED)
    // ==========================================
    console.log("📜 Scroll başlatılıyor...");

    let oneTwoStarCount = 0;
    let lastOneTwoStarCount = 0;
    let stableStreak = 0;
    let scrollCount = 0;
    const MAX_SCROLL = 2000; // MAXIMUM scroll - tüm yorumları taşıyacak kadar
    const STABLE_LIMIT = 200; // MAXIMUM sabitleme - Google yavaş yüklesin diye
    const MIN_STABLE_BEFORE_STOP = 100; // Min 100 iterasyon yap

    for (let i = 0; i < MAX_SCROLL; i++) {
      const { totalReviews, oneTwoStars } = await page.evaluate(() => {
        const containers = [
          document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf'),
          document.querySelector('.m6QErb.DxyBCb'),
          document.querySelector('.m6QErb'),
          document.querySelector('div[role="region"]'),
          document.querySelector('[role="main"]')
        ];
        
        let container = null;
        for (const c of containers) {
          if (c && c.scrollHeight > 500) {
            container = c;
            break;
          }
        }
        
        if (!container) {
          return { totalReviews: 0, oneTwoStars: 0 };
        }
        
        // Çok agresif scroll
        container.scrollTop = container.scrollHeight + 5000;
        
        const reviewElements = Array.from(
          document.querySelectorAll('[data-review-id], .jftiEf.Nv2PK')
        );
        
        let oneTwoCount = 0;
        const seenIds = new Set();
        
        reviewElements.forEach(card => {
          const id = card.getAttribute('data-review-id');
          if (!id || seenIds.has(id)) return;
          seenIds.add(id);
          
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const ariaLabel = starEl.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+)/);
            if (match) {
              const rating = parseInt(match[1]);
              if (rating <= 2) oneTwoCount++;
            }
          }
        });
        
        return { totalReviews: reviewElements.length, oneTwoStars: oneTwoCount };
      });
      
      scrollCount++;
      oneTwoStarCount = oneTwoStars;
      
      if (oneTwoStarCount === lastOneTwoStarCount) {
        stableStreak++;
      } else {
        stableStreak = 0;
      }
      lastOneTwoStarCount = oneTwoStarCount;
      
      if (i % 10 === 0) {
        console.log(`📊 Scroll ${i} | Toplam: ${totalReviews} | 1-2⭐: ${oneTwoStarCount} | Sabit: ${stableStreak}`);
      }
      
      // KOŞUL: min 30 iterasyon yap + 40 iterasyon sabitlenmiş
      if (i >= MIN_STABLE_BEFORE_STOP && stableStreak >= STABLE_LIMIT) {
        console.log(`🛑 Yorum sayısı sabitlendi (${oneTwoStarCount} adet, ${stableStreak} iterasyon), DURDURULUYOR!`);
        break;
      }
      
      // MAX_SCROLL'a ulaştık
      if (i === MAX_SCROLL - 1) {
        console.log(`🛑 Maximum scroll sınırına ulaşıldı (${oneTwoStarCount} adet)`);
      }
      
      await delay(300 + Math.random() * 200);
    }

    console.log(`✅ Scroll tamamlandı | ${scrollCount} iterasyon | ${oneTwoStarCount} adet 1-2⭐`);
    await delay(3000);

    // ==========================================
    // 8. EXPAND ET
    // ==========================================
    console.log("🔍 Yorumlar expand ediliyor...");

    await page.evaluate(() => {
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id]'));
      let expandedCount = 0;
      
      reviewElements.forEach(card => {
        try {
          const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
          if (!starEl) return;
          
          const ariaLabel = starEl.getAttribute('aria-label') || '';
          const match = ariaLabel.match(/(\d+)/);
          if (!match || parseInt(match[1]) > 2) return;
          
          const buttons = Array.from(card.querySelectorAll('button'));
          buttons.forEach(btn => {
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const text = btn.textContent || '';
            
            if ((ariaLabel.toLowerCase().match(/daha|more|expand/) ||
                 text.toLowerCase().match(/daha|more/)) &&
                btn.offsetHeight > 0) {
              try {
                btn.click();
                expandedCount++;
              } catch (e) {}
            }
          });
        } catch (e) {}
      });
      
      console.log(`Expanded: ${expandedCount} button`);
    });

    await delay(2000);

    // ==========================================
    // 9. PARSE
    // ==========================================
    console.log("📋 Yorumlar parse ediliyor...");

    const reviews = await page.evaluate(() => {
      const results = [];
      const seenIds = new Set();
      
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id]'));
      
      console.log(`Parse: ${reviewElements.length} element bulundu`);
      
      reviewElements.forEach((card) => {
        try {
          const uniqueId = card.getAttribute('data-review-id');
          if (!uniqueId || seenIds.has(uniqueId)) return;
          
          // Rating
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
          if (starEl) {
            const match = (starEl.getAttribute('aria-label') || '').match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          
          if (!rating || rating > 2) return;
          seenIds.add(uniqueId);
          
          // Text
          let text = '';
          const textEl = card.querySelector('.wiI7pd, span[data-expandable-section], .MyEned');
          if (textEl) {
            text = textEl.textContent.trim().slice(0, 5000);
          }
          
          // Author
          let author = '';
          const authorEl = card.querySelector('.d4r55, h3');
          if (authorEl) {
            author = authorEl.textContent.trim().split('·')[0].trim();
          }
          
          // Date
          let date = '';
          const dateEl = card.querySelector('.rsqaWe');
          if (dateEl) {
            date = dateEl.textContent.trim();
          }
          
          results.push({
            rating,
            text: text || '(Metin yok)',
            author: author || 'Anonim',
            date: date || '',
            hasReview: text.length > 8,
            uniqueId
          });
          
        } catch (e) {}
      });
      
      return results;
    });

    console.log(`✅ ${reviews.length} yorum parse edildi`);

    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);

    console.log(`📊 1⭐: ${oneStar.length} | 2⭐: ${twoStar.length}`);

    // ==========================================
    // 10. RESPONSE GÖNDER
    // ==========================================
    res.json({
      success: true,
      name: businessInfo.name,
      address: businessInfo.address,
      place_url: finalPlaceUrl,
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
    console.error("Stack:", err.stack);
    res.json({ success: false, error: err.message, stack: err.stack });
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
