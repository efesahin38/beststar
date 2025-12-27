const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const app = express();

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.get("/debug-chrome", (req, res) => {
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
  const visitedReviews = new Set(); // Aynı yorumu tekrar almamak için

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
        "--window-size=1920,1080",
        "--single-process",
        "--no-zygote",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
      ]
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(300000); // 5 dakika
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
    });
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+cb.20210720-07-p0.tr+FX+410',
      domain: '.google.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 31536000
    });

    // Google Maps arama URL
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
    await delay(15000); // Uzun bekleme

    // Cookie consent bypass
    const currentUrl = page.url();
    if (currentUrl.includes('consent.google.com')) {
      console.log("⚠️ Consent sayfasında, bypass yapılıyor...");
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const acceptBtn = buttons.find(b => /accept|kabul|akzeptieren|alle/i.test(b.textContent));
        if (acceptBtn) acceptBtn.click();
      });
      await delay(5000);
      if (page.url().includes('consent.google.com')) {
        console.log("🔄 Form submit deneniyor...");
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) form.submit();
        });
        await delay(5000);
      }
    }

    // Sayfa yeniden yükle
    if (!page.url().includes('/maps/')) {
      console.log("🔄 Maps sayfasına yönlendiriliyor...");
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
      await delay(10000);
    }
    console.log("✅ Consent geçildi, Maps sayfasındayız");

    // Sayfa yapısını analiz et
    const pageAnalysis = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
        hfpxzc: document.querySelectorAll('.hfpxzc').length,
        Nv2PK: document.querySelectorAll('.Nv2PK').length,
        qBF1Pd: document.querySelectorAll('.qBF1Pd').length,
        articles: document.querySelectorAll('div[role="article"]').length,
        divs: document.querySelectorAll('div').length,
        links: document.querySelectorAll('a').length
      };
    });
    console.log("📊 Sayfa Analizi:", JSON.stringify(pageAnalysis, null, 2));

    // İşletme kartını bulma (gelişmiş stratejiler)
    let placeFound = false;

    // 1. Strateji: Place link bekle ve tıkla
    if (!placeFound) {
      try {
        console.log("📍 Strateji 1: Place link bekleniyor (30 saniye)...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 30000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        if (placeLinks.length > 0) {
          const firstLinkInfo = await page.evaluate(el => ({ text: el.textContent?.trim().substring(0, 50), href: el.href }), placeLinks[0]);
          console.log(`📌 Tıklanacak link: ${firstLinkInfo.text} - ${firstLinkInfo.href.substring(0, 80)}`);
          await placeLinks[0].click();
          placeFound = true;
          await delay(5000);
          await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
          await delay(5000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 1 başarısız:", e.message);
      }
    }

    // 2. Strateji: Kartlara tıkla
    if (!placeFound) {
      try {
        const cardSelectors = ['.hfpxzc', '.Nv2PK', 'div[role="article"]', '.qBF1Pd', 'div[jsaction*="mouseover"]', 'a.hfpxzc'];
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          if (cards.length > 0) {
            await cards[0].click();
            console.log(`✅ Kart tıklandı (${selector})`);
            placeFound = true;
            await delay(5000);
            break;
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 2 başarısız:", e.message);
      }
    }

    // 3. Koordinat tıklama
    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Koordinat tıklama...");
        await page.mouse.click(400, 400);
        await delay(5000);
        if (page.url().includes('/maps/place/')) {
          console.log("✅ Koordinat tıklama başarılı");
          placeFound = true;
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // 4. Direkt URL ile git
    if (!placeFound) {
      try {
        console.log("📍 Strateji 4: Direkt URL...");
        const placeUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="/maps/place/"]');
          return link ? link.href : null;
        });
        if (placeUrl) {
          console.log(`🔗 URL'ye gidiliyor: ${placeUrl.substring(0, 100)}...`);
          await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          placeFound = true;
          await delay(10000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 4 başarısız");
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      await page.screenshot({ path: '/tmp/debug_no_place.png', fullPage: true });
      const html = await page.content();
      fs.writeFileSync('/tmp/debug_page.html', html);
      return res.json({ error: "İşletme kartı bulunamadı.", debug: pageAnalysis });
    }
    console.log("🎉 İşletme kartı başarıyla açıldı!");

    // İşletme bilgilerini al
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
      let address = 'Adres bulunamadı';
      const rows = Array.from(document.querySelectorAll('button[data-item-id], div[aria-label]'));
      for (const el of rows) {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = el.innerText?.replace(/\n/g, ' ').trim();
        if ((label.includes('address') || label.includes('adres')) && text && text.length > 10) {
          address = text;
          break;
        }
      }
      return { name, address };
    });
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // Yorumlar sekmesini aç
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(3000);
    let reviewsOpened = false;

    // Yorum butonu tıklama
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button.hh2c6',
      'button[jsaction*="reviewChart"]',
      'div.AeaXub button',
      'button[data-tab-index="1"]'
    ];
    for (const selector of reviewButtonSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          console.log(`🎯 Yorum butonu bulundu: ${selector}`);
          reviewsOpened = true;
          await delay(5000);
          break;
        }
      } catch (e) {
        // Devam et
      }
    }

    // Alternatif: Tab ile aç
    if (!reviewsOpened) {
      try {
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('Tab');
          await delay(300);
        }
        await page.keyboard.press('Enter');
        await delay(5000);
        reviewsOpened = true;
      } catch (e) {
        console.log("⚠️ Tab navigation başarısız");
      }
    }

    // Sıralama menüsü
    console.log("⭐ Sıralama menüsü açılıyor...");
    await delay(2000);
    try {
      const sortSelectors = [
        'button[aria-label*="sırala" i]',
        'button[aria-label*="sort" i]',
        'button[data-value="Sort"]',
        'button[aria-label*="sortieren" i]'
      ];
      for (const selector of sortSelectors) {
        const sortBtn = await page.$(selector);
        if (sortBtn) {
          await sortBtn.click();
          console.log("✅ Sıralama menüsü açıldı");
          await delay(1500);
          // En düşük puan
          const lowestSelectors = [
            '[data-index="1"]',
            'div[role="menuitemradio"]:nth-child(2)',
            'li[role="menuitemradio"]:nth-child(2)',
            '[data-value="qualityScore"]'
          ];
          for (const opt of lowestSelectors) {
            const option = await page.$(opt);
            if (option) {
              await option.click();
              console.log("✅ En düşük puanlı seçildi");
              await delay(3000);
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı, tüm yorumlar çekilecek");
    }

    // Yorumları scroll ile yükle
    console.log("📜 Scroll başlatılıyor...");
    let lastCount = 0;
    let sameCountStreak = 0;
    const MAX_SCROLL = 400;
    const SAME_LIMIT = 8;
    for (let i = 0; i < MAX_SCROLL; i++) {
      const { reviews } = await page.evaluate(() => {
        const containers = [
          document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf'),
          document.querySelector('.m6QErb'),
          document.querySelector('div[role="region"]'),
          document.querySelector('[role="main"]'),
          document.querySelector('div[tabindex="-1"]')
        ];
        const container = containers.find(c => c !== null);
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
        const reviewCount = Math.max(
          document.querySelectorAll('[data-review-id]').length,
          document.querySelectorAll('.jftiEf').length,
          document.querySelectorAll('div[role="article"]').length,
          document.querySelectorAll('.MyEned').length
        );
        return { reviews: reviewCount };
      });
      await delay(1200);
      if (lastCount === reviews) {
        sameCountStreak++;
      } else {
        sameCountStreak = 0;
      }
      lastCount = reviews;
      if (i % 15 === 0) {
        console.log(`📊 Scroll ${i} | Yorum: ${reviews} | Sabit: ${sameCountStreak}`);
      }
      if (sameCountStreak >= SAME_LIMIT && i > 15) {
        console.log("🛑 Yorum sayısı artmıyor, durduruluyor");
        break;
      }
    }
    console.log(`✅ Scroll tamamlandı | Son yorum sayısı: ${lastCount}`);
    await delay(3000);

    // Yorumları çek
    console.log("🔍 Yorumlar parse ediliyor...");
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenKeys = new Set();

      const reviewSelectors = [
        'div[role="article"]',
        '[data-review-id]',
        '.jftiEf',
        '.MyEned'
      ];

      let reviewElements = [];
      for (const selector of reviewSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > reviewElements.length) {
          reviewElements = Array.from(els);
        }
      }

      console.log(`📝 ${reviewElements.length} yorum kartı bulundu`);

      for (const card of reviewElements) {
        // Yorum detaylarını al
        try {
          // Yıldız
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          if (!rating || rating > 2) continue; // Sadece 1-2 yıldız

          let text = '';
          const textEl = card.querySelector('.wiI7pd, span[data-expandable-section]');
          if (textEl) text = textEl.textContent?.trim() || '';

          let author = 'Anonim';
          const authorEl = card.querySelector('.d4r55');
          if (authorEl) {
            author = authorEl.textContent?.trim().split('·')[0].trim() || 'Anonim';
          }

          // Aynı yorumu tekrar alma
          const hasText = text.length > 0;
          const uniqueKey = hasText ? `text_${text.substring(0, 80)}` : `empty_${author}_${rating}`;

          if (visitedReviews.has(uniqueKey)) continue;
          visitedReviews.add(uniqueKey);

          results.push({ rating, text, author, hasReview: hasText });
        } catch (e) {
          // hata olursa devam et
        }
      }
      return results;
    });

    console.log(`✅ Toplam ${reviews.length} adet 1-2 yıldızlı yorum çekildi`);

    // İstatistikler
    const oneStarCount = reviews.filter(r => r.rating === 1).length;
    const twoStarCount = reviews.filter(r => r.rating === 2).length;

    res.json({
      success: true,
      name: await page.evaluate(() => document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı'),
      address: await page.evaluate(() => {
        let addr = 'Adres bulunamadı';
        const rows = Array.from(document.querySelectorAll('button[data-item-id], div[aria-label]'));
        for (const el of rows) {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          const text = el.innerText?.replace(/\n/g, ' ').trim();
          if ((label.includes('address') || label.includes('adres')) && text && text.length > 10) {
            addr = text;
            break;
          }
        }
        return addr;
      }),
      "1_star": oneStarCount,
      "2_star": twoStarCount,
      "1_star_with_text": reviews.filter(r => r.rating === 1 && r.hasReview).length,
      "1_star_without_text": reviews.filter(r => r.rating === 1 && !r.hasReview).length,
      "2_star": twoStarCount,
      "2_star_with_text": reviews.filter(r => r.rating === 2 && r.hasReview).length,
      "2_star_without_text": reviews.filter(r => r.rating === 2 && !r.hasReview).length,
      reviews_1_star: reviews.filter(r => r.rating === 1),
      reviews_2_star: reviews.filter(r => r.rating === 2),
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
