const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const app = express();

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

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
  const business = req.body.business?.trim();
  if (!business) {
    return res.json({ error: "İşletme adı gerekli." });
  }

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
        "--window-size=1280,1080",
        "--single-process",
        "--no-zygote",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
      ]
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(300000);
    await page.setViewport({ width: 1280, height: 1080 });

    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
    });

    // Güncel CONSENT cookie - Aralık 2025 itibarıyla çalışan değer
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+srp.gws-20241201-0-RC1.tr+FX+412',
      domain: '.google.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 31536000
    });

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 180000 });
    await delay(15000); // Sayfa tamamen yerleşsin

    // Consent sayfası kontrolü ve bypass
    if (page.url().includes('consent.google.com')) {
      console.log("⚠️ Consent sayfası tespit edildi, bypass yapılıyor...");
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const accept = buttons.find(b =>
          b.textContent.toLowerCase().includes('kabul') ||
          b.textContent.toLowerCase().includes('accept') ||
          b.textContent.toLowerCase().includes('alle')
        );
        if (accept) accept.click();
      });
      await delay(5000);

      if (page.url().includes('consent.google.com')) {
        await page.evaluate(() => document.querySelector('form')?.submit());
        await delay(5000);
      }

      await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 180000 });
      await delay(10000);
    }

    console.log("✅ Google Maps arama sayfası yüklendi");

    // Sayfa yapısı analizi (debug için)
    const pageAnalysis = await page.evaluate(() => ({
      url: location.href,
      placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
      hfpxzc: document.querySelectorAll('.hfpxzc').length,
      Nv2PK: document.querySelectorAll('.Nv2PK').length,
      articles: document.querySelectorAll('div[role="article"]').length
    }));
    console.log("📊 Sayfa Analizi:", pageAnalysis);

    let placeFound = false;

    // STRATEJİ 1: En güvenilir yöntem - Place linkini uzun süre bekle
    try {
      console.log("📍 Strateji 1: Place link bekleniyor (90 saniye timeout)...");
      await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 90000 });

      const placeLinks = await page.$$('a[href*="/maps/place/"]');
      if (placeLinks.length > 0) {
        const linkText = await page.evaluate(el => el.textContent?.trim().substring(0, 50), placeLinks[0]);
        console.log(`📌 İlk uygun link bulundu: "${linkText}"`);

        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => console.log("Navigation timeout, devam ediliyor")),
          placeLinks[0].click()
        ]);

        placeFound = true;
        await delay(8000);
        console.log("✅ İşletme detay sayfası açıldı (Strateji 1)");
      }
    } catch (e) {
      console.log("⚠️ Strateji 1 başarısız:", e.message.substring(0, 120));
    }

    // STRATEJİ 2: Kartlara tıklama
    if (!placeFound) {
      try {
        console.log("📍 Strateji 2: Kartlara tıklama deneniyor...");
        const cardSelectors = ['.hfpxzc', '.Nv2PK', 'div[role="article"]', '.qBF1Pd', 'a.hfpxzc'];
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          if (cards.length > 0) {
            const cardText = await page.evaluate(el => el.textContent?.trim().substring(0, 50), cards[0]);
            if (cardText.toLowerCase().includes(business.toLowerCase().substring(0, 10))) {
              await cards[0].click();
              await delay(8000);
              if (page.url().includes('/maps/place/')) {
                placeFound = true;
                console.log(`✅ Kart tıklandı ve işletme açıldı (${selector})`);
                break;
              }
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 2 başarısız:", e.message.substring(0, 120));
      }
    }

    // STRATEJİ 3: Orta bölgeye tıklama (son çare)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Orta bölgeye tıklama...");
        await page.mouse.click(640, 400); // Ekran ortası
        await delay(7000);
        if (page.url().includes('/maps/place/')) {
          placeFound = true;
          console.log("✅ Koordinat tıklama ile işletme açıldı");
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // Hiçbir strateji çalışmadıysa hata ver
    if (!placeFound) {
      console.log("❌ Tüm stratejiler başarısız oldu. İşletme kartı bulunamadı.");
      return res.json({
        success: false,
        error: "İşletme kartı bulunamadı. Google sayfayı kapattı veya yapı değişti.",
        debug: pageAnalysis
      });
    }

    console.log("🎉 İşletme detay sayfası başarıyla açıldı!");

    // İşletme adı ve adres çekme
    await page.waitForSelector('h1', { timeout: 30000 }).catch(() => console.log("h1 beklenmedi"));
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1')?.innerText?.trim() || 'Ad bulunamadı';

      let address = 'Adres bulunamadı';
      const candidates = document.querySelectorAll('button[data-item-id], button[aria-label*="Adres"], div[aria-label*="Adres"]');
      for (const el of candidates) {
        const text = el.innerText?.trim() || el.getAttribute('aria-label')?.trim() || '';
        if (text && text.length > 10 && (text.includes(',') || /\d{5}/.test(text))) {
          address = text;
          break;
        }
      }
      return { name, address };
    });

    console.log(`🏢 İşletme: ${businessInfo.name}`);
    console.log(`📍 Adres: ${businessInfo.address}`);

    // YORUMLAR SEKMESİ AÇMA
    console.log("💬 Yorumlar sekmesi açılıyor...");
    let reviewsOpened = false;
    const reviewSelectors = [
      'button[aria-label*="Yorum" i]',
      'button[aria-label*="Review" i]',
      'button[jsaction*="pane.rating.moreReviews"]',
      'button.hh2c6',
      'div[role="tablist"] button:nth-child(2)',
      'button[data-tab-index="1"]',
      'button[role="tab"]:nth-child(2)'
    ];

    for (const selector of reviewSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 15000 });
        await page.click(selector);
        await delay(6000);
        reviewsOpened = true;
        console.log(`✅ Yorum sekmesi açıldı (${selector})`);
        break;
      } catch (e) {
        // devam et
      }
    }

    if (!reviewsOpened) {
      console.log("❌ Yorumlar sekmesi açılamadı.");
      return res.json({ success: false, error: "Yorumlar sekmesi açılamadı." });
    }

    // SIRALAMA: En düşük puanlı
    console.log("⭐ Sıralama menüsü: En düşük puanlı seçiliyor...");
    try {
      const sortButton = await page.$('button[aria-label*="Sırala" i], button[aria-label*="Sort" i]');
      if (sortButton) {
        await sortButton.click();
        await delay(2000);

        const lowestOption = await page.$('[data-index="1"], div[role="menuitemradio"]:nth-child(2), [aria-label*="en düşük" i]');
        if (lowestOption) {
          await lowestOption.click();
          await delay(4000);
          console.log("✅ En düşük puanlı sıralama seçildi");
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı, tüm yorumlar çekilecek");
    }

    // SCROLL: Yavaş ve uzun (yorum kaçırmamak için)
    console.log("📜 Yorumlar scroll ediliyor (yavaş ve uzun süreç)...");
    let lastCount = 0;
    let sameStreak = 0;
    const MAX_SCROLL = 500;
    const SAME_LIMIT = 15;

    for (let i = 0; i < MAX_SCROLL; i++) {
      const currentCount = await page.evaluate(() => {
        const container = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
                          document.querySelector('.m6QErb') ||
                          document.querySelector('div[role="region"]') ||
                          document.querySelector('[role="main"]');
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
        return Math.max(
          document.querySelectorAll('[data-review-id]').length,
          document.querySelectorAll('.jftiEf').length,
          document.querySelectorAll('.MyEned').length,
          document.querySelectorAll('div[role="article"]').length
        );
      });

      await delay(1500); // Yavaş scroll, tespit riskini azaltır

      if (currentCount === lastCount) {
        sameStreak++;
      } else {
        sameStreak = 0;
      }
      lastCount = currentCount;

      if (i % 30 === 0 && i > 0) {
        console.log(`📊 Scroll ${i} → ${currentCount} yorum (sabit streak: ${sameStreak})`);
      }

      if (sameStreak >= SAME_LIMIT && i > 30) {
        console.log("🛑 Yorum yüklenmesi durdu, scroll tamamlandı");
        break;
      }
    }

    await delay(3000); // Son yüklemeler için

    // YORUMLARI ÇEKME (1-2 yıldızlı, duplikat önleme güçlü)
    console.log("🔍 1-2 yıldızlı yorumlar parse ediliyor...");
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenKeys = new Set();

      // Tüm yorum kartlarını topla
      const reviewCards = Array.from(document.querySelectorAll('.jftiEf, .MyEned, [data-review-id], div[role="article"]'));

      // "Daha fazla" butonlarını aç
      reviewCards.forEach(card => {
        card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe').forEach(btn => {
          if (btn.offsetParent !== null) { // Görünürse
            btn.click();
          }
        });
      });

      // Yorumları parse et
      reviewCards.forEach(card => {
        try {
          const starEl = card.querySelector('[role="img"][aria-label*="yıldız" i], [role="img"][aria-label*="star" i]');
          if (!starEl) return;

          const ratingText = starEl.getAttribute('aria-label') || '';
          const ratingMatch = ratingText.match(/(\d+)/);
          const rating = ratingMatch ? parseInt(ratingMatch[1]) : null;

          if (rating !== 1 && rating !== 2) return;

          const textEl = card.querySelector('.wiI7pd');
          const text = textEl ? textEl.textContent.trim() : '';

          const authorEl = card.querySelector('.d4r55');
          const author = authorEl ? authorEl.textContent.split('·')[0].trim() : 'Anonim';

          // Güçlü duplikat kontrolü
          const uniqueKey = `${rating}|${author}|${text.substring(0, 120)}`;
          if (seenKeys.has(uniqueKey)) return;
          seenKeys.add(uniqueKey);

          results.push({
            rating,
            text,
            author,
            hasReview: text.length > 0
          });
        } catch (e) {
          // Hata olsa bile devam
        }
      });

      return results;
    });

    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);

    console.log(`✅ Toplam ${reviews.length} adet düşük puanlı yorum çekildi`);
    console.log(`   → 1 yıldız: ${oneStar.length} (metinli: ${oneStar.filter(r => r.hasReview).length})`);
    console.log(`   → 2 yıldız: ${twoStar.length} (metinli: ${twoStar.filter(r => r.hasReview).length})`);

    // Sonuç döndür
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
    console.error("❌ Kritik hata:", err.message);
    console.error("Stack:", err.stack);
    res.json({ success: false, error: err.message || "Bilinmeyen bir hata oluştu" });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log("🔒 Browser kapatıldı");
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server http://localhost:${PORT} adresinde çalışıyor`);
  console.log(`💡 Health check: http://localhost:${PORT}/health`);
  console.log(`💡 Chrome debug: http://localhost:${PORT}/debug-chrome`);
});
