const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const app = express();

app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const visitedReviews = new Set();

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
    await page.setDefaultTimeout(300000);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    // Google cookies
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+cb.20210720-07-p0.tr+FX+410',
      domain: '.google.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 31536000
    });

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await delay(15000);

    // Consent bypass
    if (page.url().includes('consent.google.com')) {
      console.log("⚠️ Consent sayfasında, bypass yapılıyor...");
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const acceptBtn = btns.find(b => /accept|kabul|akzeptieren|alle/i.test(b.textContent));
        if (acceptBtn) acceptBtn.click();
      });
      await delay(5000);
      if (page.url().includes('consent.google.com')) {
        await page.evaluate(() => {
          document.querySelector('form')?.submit();
        });
        await delay(5000);
      }
    }

    // Yönlendirme durumu
    if (!page.url().includes('/maps/')) {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await delay(10000);
    }
    console.log("✅ Consent geçildi, Maps sayfasındayız");

    // Sayfa analizi
    const pageAnalysis = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        placeLinksCount: document.querySelectorAll('a[href*="/maps/place/"]').length,
        hfpxzcCount: document.querySelectorAll('.hfpxzc').length,
        Nv2PKCount: document.querySelectorAll('.Nv2PK').length,
        qBF1PdCount: document.querySelectorAll('.qBF1Pd').length,
        articleCount: document.querySelectorAll('div[role="article"]').length,
        divCount: document.querySelectorAll('div').length,
        linkCount: document.querySelectorAll('a').length
      };
    });
    console.log("📊 Sayfa analizi", pageAnalysis);

    // İşletme kartını bulmak
    let placeFound = false;

    // 1. Yöntem: Place link
    if (!placeFound) {
      try {
        console.log("📍 Place link aranıyor...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 30000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        if (placeLinks.length > 0) {
          await placeLinks[0].click();
          placeFound = true;
          await delay(5000);
          await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      } catch (e) {
        console.log("⚠️ Place link bulunamadı");
      }
    }

    // 2. Yöntem: Kartlara tıkla
    if (!placeFound) {
      try {
        const selectors = ['.hfpxzc', '.Nv2PK', 'div[role="article"]', '.qBF1Pd'];
        for (const sel of selectors) {
          const elems = await page.$$(sel);
          if (elems.length > 0) {
            await elems[0].click();
            placeFound = true;
            await delay(5000);
            break;
          }
        }
      } catch (e) {
        console.log("⚠️ Kartlara tıklama başarısız");
      }
    }

    // 3. Koordinat tıklama
    if (!placeFound) {
      try {
        await page.mouse.click(400, 400);
        await delay(5000);
        if (page.url().includes('/maps/place/')) {
          placeFound = true;
        }
      } catch (e) {
        console.log("⚠️ Koordinat tıklama başarısız");
      }
    }

    // 4. Direkt URL
    if (!placeFound) {
      try {
        const placeUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="/maps/place/"]');
          return link?.href || null;
        });
        if (placeUrl) {
          await page.goto(placeUrl, { waitUntil: 'domcontentloaded' });
          await delay(10000);
          placeFound = true;
        }
      } catch (e) {
        console.log("⚠️ Direkt URL başarısız");
      }
    }

    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı");
      await page.screenshot({ path: '/tmp/no_place.png', fullPage: true });
      const html = await page.content();
      fs.writeFileSync('/tmp/page.html', html);
      return res.json({ error: "İşletme kartı bulunamadı", debug: pageAnalysis });
    }
    console.log("🎉 İşletme kartı bulundu!");

    // İşletme bilgisi
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
      let address = 'Adres bulunamadı';
      const addrEl = document.querySelector('button[data-item-id], div[aria-label]');
      if (addrEl) {
        address = addrEl.innerText?.replace(/\n/g, ' ').trim() || address;
      }
      return { name, address };
    });
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);

    // Yorumlar sekmesini aç
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(3000);

    // Yorumlar butonunu bul ve tıkla
    const reviewBtnSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'div.AeaXub button'
    ];

    let reviewsTabOpened = false;
    for (const sel of reviewBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          reviewsTabOpened = true;
          await delay(5000);
          break;
        }
      } catch (e) {}
    }

    // Alternatif: Tab ile aç
    if (!reviewsTabOpened) {
      try {
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('Tab');
          await delay(300);
        }
        await page.keyboard.press('Enter');
        await delay(5000);
      } catch (e) {}
    }

    // Sıralama menüsü
    console.log("⭐ Sıralama menüsü açılıyor...");
    await delay(2000);
    try {
      const sortSelectors = [
        'button[aria-label*="sırala" i]',
        'button[aria-label*="sort" i]'
      ];
      for (const sel of sortSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await delay(1500);
          // En düşük puan
          const optionsSelectors = [
            '[data-index="1"]', // 1 yıldız
            'div[role="menuitem"]:nth-child(2)'
          ];
          for (const optSel of optionsSelectors) {
            const opt = await page.$(optSel);
            if (opt) {
              await opt.click();
              await delay(3000);
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı, tüm yorumlar yükleniyor");
    }

    // Yorumları scroll ile yükle
    console.log("📜 Scroll başlıyor...");
    let lastCount = 0;
    let sameCount = 0;
    const MAX_SCROLL = 400;
    const SAME_LIMIT = 8;

    for (let i = 0; i < MAX_SCROLL; i++) {
      const { reviewCount } = await page.evaluate(() => {
        const container = document.querySelector('div[role="region"]') || document.querySelector('div[aria-label="Yorumlar"]');
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
        const reviews = document.querySelectorAll('[data-review-id], div[role="article"], .jftiEf, .MyEned');
        return { reviewCount: reviews.length };
      });
      await delay(1200);

      if (lastCount === reviewCount) {
        sameCount++;
      } else {
        sameCount = 0;
      }
      lastCount = reviewCount;

      if (i % 15 === 0) {
        console.log(`🔄 Scroll: ${i} | Toplam Yorum: ${reviewCount} | Sabit: ${sameCount}`);
      }

      if (sameCount >= SAME_LIMIT && i > 15) {
        console.log("🛑 Yorumlar değişmiyor, durduruluyor...");
        break;
      }
    }
    console.log(`✅ Scroll tamamlandı, toplam yorum: ${lastCount}`);
    await delay(3000);

    // Yorumları parse et
    console.log("🔍 Yorumlar alınıyor...");
    const reviews = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const reviewNodes = Array.from(document.querySelectorAll('[data-review-id], div[role="article"], .jftiEf, .MyEned'));
      console.log(`📝 Toplam Yorum Kartı: ${reviewNodes.length}`);

      reviewNodes.forEach(node => {
        try {
          // Yıldız
          let rating = null;
          const starEl = node.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          if (!rating || rating > 2) return; // sadece 1-2 yıldız

          // Yorum metni
          let text = '';
          const textEl = node.querySelector('.wiI7pd, span[data-expandable-section]');
          if (textEl) {
            text = textEl.innerText.trim();
          }

          // Yazar
          let author = 'Anonim';
          const authorEl = node.querySelector('.d4r55');
          if (authorEl) {
            author = authorEl.innerText.trim().split('·')[0];
          }

          // Benzersiz anahtar
          const keyText = text.length > 0 ? text.substring(0, 80) : '';
          const key = `text_${keyText}_${author}_${rating}`;

          if (seen.has(key)) return;
          seen.add(key);

          results.push({ rating, text, author, hasReview: text.length > 0 });
        } catch (e) {}
      });
      return results;
    });

    console.log(`✅ Çekilen 1 ve 2 yıldızlı yorumlar: ${reviews.length}`);

    // İstatistikler
    const oneStarCount = reviews.filter(r => r.rating === 1).length;
    const twoStarCount = reviews.filter(r => r.rating === 2).length;

    res.json({
      success: true,
      name: await page.evaluate(() => document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || 'İşletme adı bulunamadı'),
      address: await page.evaluate(() => {
        const addrEl = document.querySelector('button[data-item-id], div[aria-label]');
        return addrEl ? addrEl.innerText.replace(/\n/g, ' ').trim() : 'Adres bulunamadı';
      }),
      "1_star": oneStarCount,
      "2_star": twoStarCount,
      "1_star_with_text": reviews.filter(r => r.rating === 1 && r.hasReview).length,
      "1_star_without_text": reviews.filter(r => r.rating === 1 && !r.hasReview).length,
      "2_star_with_text": reviews.filter(r => r.rating === 2 && r.hasReview).length,
      "2_star_without_text": reviews.filter(r => r.rating === 2 && r.hasReview).length,
      reviews_1_star: reviews.filter(r => r.rating === 1),
      reviews_2_star: reviews.filter(r => r.rating === 2),
      total_reviews_scraped: reviews.length
    });

  } catch (err) {
    console.error("❌ Hata:", err.message);
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
