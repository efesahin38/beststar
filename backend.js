const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

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
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800", // Daha küçük pencere boyutu için hafıza optimizasyonu
        "--single-process",
        "--no-zygote",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      ],
      dumpio: false // Logları azalt
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(180000); // 3 dakika genel timeout

    await page.setViewport({ width: 1280, height: 800 }); // Küçük viewport hafıza için

    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
    });

    // Cookie consent önceden set et
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+cb.20210720-07-p0.tr+FX+410',
      domain: '.google.com',
      path: '/',
      expires: Date.now() / 1000 + 31536000
    });

    // 1. Google Maps search
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    console.log("⏳ Sayfa yükleniyor (10 saniye bekleme)...");
    await delay(10000); // Kısa bekleme

    // 2. Cookie consent handler - Daha güvenilir
    console.log("🍪 Cookie kontrolü...");
    let currentUrl = await page.url();
    if (currentUrl.includes('consent.google.com')) {
      console.log("⚠️ Consent sayfasında, bypass yapılıyor...");
      // JS ile buton bul ve tıkla
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const acceptBtn = buttons.find(b => {
          const text = (b.textContent || '').toLowerCase();
          return text.includes('accept') || text.includes('kabul') || text.includes('akzeptieren') || text.includes('alle') || text.includes('agree');
        });
        if (acceptBtn) acceptBtn.click();
      });
      await delay(3000);

      // Hala consent'te mi?
      currentUrl = await page.url();
      if (currentUrl.includes('consent.google.com')) {
        console.log("🔄 Form submit deneniyor...");
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) form.submit();
        });
        await delay(3000);
      }
    }

    // Consent sonrası tekrar Maps'e git
    if (!(await page.url()).includes('/maps/')) {
      console.log("🔄 Maps sayfasına yönlendiriliyor...");
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await delay(8000);
    }
    console.log("✅ Consent geçildi, Maps sayfasındayız");

    // 3. Sayfa yapısını analiz et (hafifletilmiş)
    console.log("🔍 Sayfa yapısı analiz ediliyor...");
    const pageAnalysis = await page.evaluate(() => {
      return {
        url: window.location.href,
        placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
        hfpxzc: document.querySelectorAll('.hfpxzc').length,
        Nv2PK: document.querySelectorAll('.Nv2PK').length
      };
    });
    console.log("📊 Sayfa Analizi:", JSON.stringify(pageAnalysis, null, 2));

    // 4. İşletme kartını bul - Daha fazla strateji ve timeout
    console.log("🎯 İşletme kartı aranıyor...");
    let placeFound = false;

    // Strateji 1: Place link bekle ve tıkla (uzun timeout)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 1: Place link bekleniyor (45 saniye)...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 45000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        console.log(`✅ ${placeLinks.length} place link bulundu`);
        if (placeLinks.length > 0) {
          // İlk linkin business adına benzerliğini kontrol et (güvenilirlik için)
          const firstLinkInfo = await page.evaluate(el => ({
            text: el.textContent?.trim().substring(0, 50).toLowerCase(),
            href: el.href
          }), placeLinks[0]);
          const businessLower = business.toLowerCase();
          if (firstLinkInfo.text.includes(businessLower.substring(0, 10))) {
            console.log(`📌 Tıklanacak link: ${firstLinkInfo.text} - ${firstLinkInfo.href.substring(0, 80)}`);
            await placeLinks[0].click();
            console.log("✅ Link tıklandı");
            placeFound = true;
            await delay(4000);
            await page.waitForNavigation({ timeout: 20000 }).catch(() => console.log("⏳ Navigation yok, devam"));
            await delay(4000);
          } else {
            console.log("⚠️ İlk link eşleşmiyor, sonraki deneniyor...");
            // İkinci link dene
            if (placeLinks.length > 1) {
              await placeLinks[1].click();
              placeFound = true;
              await delay(4000);
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 1 başarısız:", e.message);
      }
    }

    // Strateji 2: Kart selectors ile tıkla
    if (!placeFound) {
      try {
        console.log("📍 Strateji 2: Kart selectors...");
        const cardSelectors = [
          '.hfpxzc',
          '.Nv2PK',
          'div[role="article"]',
          '.qBF1Pd',
          'div[jsaction*="mouseover"]',
          'a.hfpxzc'
        ];
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          console.log(` ${selector}: ${cards.length} adet`);
          if (cards.length > 0) {
            // İlk kartın text'ini kontrol et
            const cardText = await page.evaluate(el => el.textContent?.trim().toLowerCase().substring(0, 50), cards[0]);
            if (cardText.includes(business.toLowerCase().substring(0, 10))) {
              await cards[0].click();
              console.log(`✅ Kart tıklandı (${selector})`);
              placeFound = true;
              await delay(4000);
              break;
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 2 başarısız:", e.message);
      }
    }

    // Strateji 3: Arama çubuğuna tekrar yaz ve enter
    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Arama çubuğu reset...");
        const searchInput = await page.$('input#searchboxinput');
        if (searchInput) {
          await searchInput.focus();
          await searchInput.type(business, { delay: 100 });
          await page.keyboard.press('Enter');
          await delay(8000);
          // Tekrar place link dene
          await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 30000 });
          const placeLinks = await page.$$('a[href*="/maps/place/"]');
          if (placeLinks.length > 0) {
            await placeLinks[0].click();
            placeFound = true;
            await delay(4000);
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // Strateji 4: Direkt place URL'ye git
    if (!placeFound) {
      try {
        console.log("📍 Strateji 4: Direkt URL navigasyonu...");
        const placeUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="/maps/place/"]');
          return link ? link.href : null;
        });
        if (placeUrl) {
          console.log(`🔗 URL'ye gidiliyor: ${placeUrl.substring(0, 100)}...`);
          await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          placeFound = true;
          await delay(8000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 4 başarısız");
      }
    }

    // Strateji 5: Koordinat tıklama (son çare)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 5: Koordinat tıklama...");
        await page.mouse.click(300, 300); // Daha küçük viewport için ayar
        await delay(4000);
        if ((await page.url()).includes('/maps/place/')) {
          console.log("✅ Koordinat tıklama başarılı");
          placeFound = true;
        }
      } catch (e) {
        console.log("⚠️ Strateji 5 başarısız");
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      return res.json({ error: "İşletme kartı bulunamadı. Sayfa yapısı beklenenden farklı olabilir.", debug: pageAnalysis });
    }

    console.log("🎉 İşletme kartı başarıyla açıldı!");

    // 5. İşletme bilgilerini al (hafifletilmiş)
    console.log("📋 İşletme bilgileri alınıyor...");
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 15000 }).catch(() => console.log("⚠️ H1 bulunamadı"));
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
      let address = 'Adres bulunamadı';
      const addressEl = document.querySelector('button[data-item-id*="address"], div[aria-label*="Adres"]');
      if (addressEl) address = addressEl.innerText?.trim() || address;
      return { name, address };
    });
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // 6. Yorumlar sekmesini aç - Daha güvenilir selectors
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(2000);
    let reviewsOpened = false;
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button.hh2c6',
      'button[jsaction*="reviewChart"]',
      'div.AeaXub button',
      'button[data-tab-index="1"]',
      'button[data-tooltip*="Reviews"]',
      'button[aria-label*="Bewertungen" i]' // Ek dil desteği
    ];
    for (const selector of reviewButtonSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          console.log(`🎯 Yorum butonu bulundu: ${selector}`);
          await btn.click();
          console.log("✅ Tıklandı");
          reviewsOpened = true;
          await delay(4000);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!reviewsOpened) {
      console.log("❌ Yorumlar sekmesi açılamadı!");
      return res.json({ error: "Yorumlar sekmesi açılamadı." });
    }

    // 7. Sıralama - En düşük puanlı (daha güvenilir)
    console.log("⭐ Sıralama menüsü açılıyor...");
    await delay(1500);
    try {
      const sortSelectors = [
        'button[aria-label*="sırala" i]',
        'button[aria-label*="sort" i]',
        'button[data-value="Sort"]',
        'button[aria-label*="sortieren" i]',
        'button[aria-label*="Ordenar" i]'
      ];
      let sortOpened = false;
      for (const selector of sortSelectors) {
        const sortBtn = await page.$(selector);
        if (sortBtn) {
          await sortBtn.click();
          console.log("✅ Sıralama menüsü açıldı");
          await delay(1000);
          sortOpened = true;
          break;
        }
      }
      if (sortOpened) {
        // En düşük puanlı seç (data-index 1 genellikle en düşük)
        const lowestSelectors = [
          '[data-index="1"]',
          'div[role="menuitemradio"]:nth-child(2)',
          'li[role="menuitemradio"]:nth-child(2)',
          '[data-value="qualityScore"]',
          '[data-value="lowest"]'
        ];
        for (const selector of lowestSelectors) {
          const option = await page.$(selector);
          if (option) {
            await option.click();
            console.log("✅ En düşük puanlı seçildi");
            await delay(2500);
            break;
          }
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı, varsayılan kullanılacak");
    }

    // 8. Scroll - Optimizasyonlu: Max 200 iterasyon, erken durma, kısa delay
    console.log("📜 Scroll başlatılıyor...");
    let lastReviewCount = 0;
    let sameCountStreak = 0;
    const SAME_LIMIT = 10; // Daha yüksek eşik için güvenilirlik
    const MAX_SCROLL = 400; // Azaltılmış max iterasyon hafıza için
    const SCROLL_DELAY = 800; // Kısa delay
    for (let i = 0; i < MAX_SCROLL; i++) {
      const { reviews } = await page.evaluate(() => {
        const container = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
                          document.querySelector('.m6QErb') ||
                          document.querySelector('div[role="region"]') ||
                          document.querySelector('[role="main"]');
        if (!container) return { reviews: 0 };
        container.scrollTop = container.scrollHeight;
        return { reviews: document.querySelectorAll('[data-review-id], .jftiEf').length };
      });
      await delay(SCROLL_DELAY + Math.random() * 200); // Random kısa delay
      if (reviews === lastReviewCount) {
        sameCountStreak++;
      } else {
        sameCountStreak = 0;
      }
      lastReviewCount = reviews;
      if (i % 20 === 0) {
        console.log(`📊 Scroll ${i} | Yorum: ${reviews} | Sabit: ${sameCountStreak}`);
      }
      if (sameCountStreak >= SAME_LIMIT && reviews > 50) { // Erken durma eğer yeterince yorum varsa
        console.log("🛑 Yorum sayısı artmıyor, durduruluyor");
        break;
      }
    }
    console.log(`✅ Scroll tamamlandı | Son yorum sayısı: ${lastReviewCount}`);
    await delay(2000);

    // 9. Yorumları çek - Gelişmiş duplikat önleme (hash ile)
    console.log("🔍 Yorumlar parse ediliyor...");
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenHashes = new Set(); // Hash ile duplikat önleme

      // Yorum kartlarını bul
      const reviewElements = Array.from(document.querySelectorAll('[data-review-id], .jftiEf, div[role="article"]'));

      // "Daha fazla" butonlarını tıkla (hafıza için batch)
      reviewElements.slice(0, 200).forEach(card => { // Max 200 kart parse et hafıza için
        const expandBtns = card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe');
        expandBtns.forEach(btn => {
          if (btn.offsetHeight > 0) btn.click();
        });
      });

      reviewElements.forEach((card, index) => {
        try {
          // Yıldız
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          if (!rating || rating > 2) return;

          // Metin
          let text = '';
          const textEl = card.querySelector('.wiI7pd, span[data-expandable-section]');
          if (textEl) text = textEl.textContent?.trim() || '';

          // Yazar
          let author = 'Anonim';
          const authorEl = card.querySelector('.d4r55');
          if (authorEl) author = authorEl.textContent?.trim().split('·')[0].trim() || 'Anonim';

          // Hash ile unique: text + author + rating
          const hash = `${text.substring(0, 100)}|${author}|${rating}`;
          if (seenHashes.has(hash)) return;
          seenHashes.add(hash);

          results.push({ rating, text, author, hasReview: text.length > 0 });
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


