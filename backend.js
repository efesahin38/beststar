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
        "--window-size=1280,720", // Bellek için küçültüldü
        "--single-process",
        "--no-zygote",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      ]
    });

    const page = await browser.newPage();
    await page.setDefaultTimeout(300000); // 5 dakika
    await page.setViewport({ width: 1280, height: 720 }); // Küçültüldü

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
      expires: Date.now() / 1000 + 31536000
    });

    // 1. Google Maps search
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
    console.log("🌐 Google Maps açılıyor...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
    console.log("⏳ Sayfa yükleniyor (20 saniye bekleme)...");
    await delay(20000); // Daha uzun ilk bekleme

    // 2. Cookie consent
    console.log("🍪 Cookie kontrolü...");
    const currentUrl = page.url();
    if (currentUrl.includes('consent.google.com')) {
      console.log("⚠️ Consent sayfasında, bypass yapılıyor...");
      // JS ile bypass dene
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const acceptBtn = buttons.find(b => b.textContent.toLowerCase().includes('accept') || b.textContent.toLowerCase().includes('kabul') || b.textContent.toLowerCase().includes('akzeptieren') || b.textContent.toLowerCase().includes('alle'));
        if (acceptBtn) acceptBtn.click();
      });
      await delay(5000);

      // Hala consent'te miyiz?
      if (page.url().includes('consent.google.com')) {
        console.log("🔄 Form submit deneniyor...");
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) form.submit();
        });
        await delay(5000);
      }
    }

    // Consent sonrası tekrar Maps'e git
    if (!page.url().includes('/maps/')) {
      console.log("🔄 Maps sayfasına yönlendiriliyor...");
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
      await delay(10000);
    }
    console.log("✅ Consent geçildi, Maps sayfasındayız");

    // 3. SAYFA YAPISINI ANLA
    console.log("🔍 Sayfa yapısı analiz ediliyor...");
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

    // 4. İŞLETME KARTINI BUL - GELİŞMİŞ STRATEJİLER (Daha fazla strateji ve timeout)
    console.log("🎯 İşletme kartı aranıyor...");
    let placeFound = false;

    // Strateji 1: Place link bekle ve tıkla (Daha uzun timeout)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 1: Place link bekleniyor (60 saniye)...");
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 60000 });
        const placeLinks = await page.$$('a[href*="/maps/place/"]');
        console.log(`✅ ${placeLinks.length} place link bulundu`);
        if (placeLinks.length > 0) {
          // İlk linkin bilgilerini al ve işletme adına göre doğrula
          const firstLinkInfo = await page.evaluate(el => ({ text: el.textContent?.trim().substring(0, 50), href: el.href }), placeLinks[0]);
          if (firstLinkInfo.text.toLowerCase().includes(business.toLowerCase().substring(0, 10))) {
            console.log(`📌 Tıklanacak link: ${firstLinkInfo.text} - ${firstLinkInfo.href.substring(0, 80)}`);
            await placeLinks[0].click();
            console.log("✅ Link tıklandı");
            placeFound = true;
            await delay(5000);
            await page.waitForNavigation({ timeout: 30000 }).catch(() => console.log("⏳ Navigation yok, devam"));
            await delay(5000);
          } else {
            console.log("⚠️ Link eşleşmiyor, sonraki strateji");
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 1 başarısız:", e.message);
      }
    }

    // Strateji 2: Kartlara tıkla (Genişletilmiş selectors)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 2: Kart selectors...");
        const cardSelectors = [
          '.hfpxzc',
          '.Nv2PK',
          'div[role="article"]',
          '.qBF1Pd',
          'div[jsaction*="mouseover"]',
          'a.hfpxzc',
          '.fontHeadlineSmall', // Yeni ek
          'div[aria-label*="result"]' // Yeni ek
        ];
        for (const selector of cardSelectors) {
          const cards = await page.$$(selector);
          console.log(` ${selector}: ${cards.length} adet`);
          if (cards.length > 0) {
            // Kart metnini kontrol et
            const cardText = await page.evaluate(el => el.textContent?.trim().substring(0, 50), cards[0]);
            if (cardText.toLowerCase().includes(business.toLowerCase().substring(0, 10))) {
              await cards[0].click();
              console.log(`✅ Kart tıklandı (${selector})`);
              placeFound = true;
              await delay(5000);
              break;
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 2 başarısız:", e.message);
      }
    }

    // Strateji 3: Koordinat tıklama (Birden fazla nokta dene)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 3: Koordinat tıklama...");
        const coords = [[400, 400], [300, 300], [500, 500]]; // Birden fazla dene
        for (const [x, y] of coords) {
          await page.mouse.click(x, y);
          await delay(5000);
          if (page.url().includes('/maps/place/')) {
            console.log("✅ Koordinat tıklama başarılı");
            placeFound = true;
            break;
          }
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // Strateji 4: İlk place URL'ye direkt git
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
          await delay(10000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 4 başarısız");
      }
    }

    // Strateji 5: Arama kutusuna tekrar yaz ve enter (Yeni ek)
    if (!placeFound) {
      try {
        console.log("📍 Strateji 5: Arama kutusuna tekrar yaz...");
        await page.type('input#searchboxinput', business, { delay: 100 });
        await page.keyboard.press('Enter');
        await delay(15000);
        placeFound = await page.evaluate(() => !!document.querySelector('a[href*="/maps/place/"]'));
        if (placeFound) console.log("✅ Tekrar arama başarılı");
      } catch (e) {
        console.log("⚠️ Strateji 5 başarısız");
      }
    }

    // Hiçbir strateji çalışmadıysa
    if (!placeFound) {
      console.log("❌ İşletme kartı bulunamadı!");
      // Debug için screenshot ve HTML kaydet (Bellek için optional yap)
      try {
        const fs = require('fs');
        await page.screenshot({ path: '/tmp/debug_no_place.png', fullPage: false }); // FullPage false: Bellek azalsın
        const html = await page.content();
        fs.writeFileSync('/tmp/debug_page.html', html.substring(0, 100000)); // HTML'i kısalt
        console.log("📸 Debug dosyaları kaydedildi: /tmp/");
      } catch (err) {
        console.log("⚠️ Debug dosyaları kaydedilemedi:", err.message);
      }
      return res.json({ error: "İşletme kartı bulunamadı. Sayfa yapısı beklenenden farklı olabilir.", debug: pageAnalysis });
    }

    console.log("🎉 İşletme kartı başarıyla açıldı!");

    // 5. İşletme bilgilerini al
    console.log("📋 İşletme bilgileri alınıyor...");
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 30000 }).catch(() => console.log("⚠️ H1 bulunamadı"));
    const businessInfo = await page.evaluate(() => {
      const name = document.querySelector('h1.DUwDvf, h1')?.innerText?.trim() || document.querySelector('h1')?.innerText?.trim() || 'İşletme adı bulunamadı';
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

    // 6. YORUMLAR SEKMESİNİ AÇ
    console.log("💬 Yorumlar sekmesi açılıyor...");
    await delay(3000);
    let reviewsOpened = false;
    const reviewButtonSelectors = [
      'button[jsaction*="pane.rating.moreReviews"]',
      'button[aria-label*="review" i]',
      'button[aria-label*="yorum" i]',
      'button.hh2c6',
      'button[jsaction*="reviewChart"]',
      'div.AeaXub button',
      'button[data-tab-index="1"]',
      'button[role="tab"]' // Yeni ek
    ];
    for (const selector of reviewButtonSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          console.log(`🎯 Yorum butonu bulundu: ${selector}`);
          await btn.click();
          console.log("✅ Tıklandı");
          reviewsOpened = true;
          await delay(5000);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Alternatif: Tab navigation
    if (!reviewsOpened) {
      console.log("🔄 Tab navigation deneniyor...");
      try {
        for (let i = 0; i < 10; i++) { // Daha fazla tab
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

    if (!reviewsOpened) {
      console.log("❌ Yorumlar sekmesi açılamadı!");
      return res.json({ error: "Yorumlar sekmesi açılamadı." });
    }

    // 7. SIRALAMA - EN DÜŞÜK PUANLI
    console.log("⭐ Sıralama menüsü açılıyor...");
    await delay(2000);
    try {
      const sortSelectors = [
        'button[aria-label*="sırala" i]',
        'button[aria-label*="sort" i]',
        'button[data-value="Sort"]',
        'button[aria-label*="sortieren" i]',
        'button[role="button"][aria-label*="order"]' // Yeni ek
      ];
      let sortOpened = false;
      for (const selector of sortSelectors) {
        const sortBtn = await page.$(selector);
        if (sortBtn) {
          await sortBtn.click();
          console.log("✅ Sıralama menüsü açıldı");
          await delay(1500);
          sortOpened = true;
          break;
        }
      }
      if (sortOpened) {
        // "En düşük puanlı" seçeneğini tıkla
        const lowestSelectors = [
          '[data-index="1"]',
          'div[role="menuitemradio"]:nth-child(2)',
          'li[role="menuitemradio"]:nth-child(2)',
          '[data-value="qualityScore"]',
          '[role="menuitemradio"][aria-label*="lowest" i]' // Yeni ek
        ];
        for (const selector of lowestSelectors) {
          const option = await page.$(selector);
          if (option) {
            await option.click();
            console.log("✅ En düşük puanlı seçildi");
            await delay(3000);
            break;
          }
        }
      }
    } catch (e) {
      console.log("⚠️ Sıralama yapılamadı, tüm yorumlar çekilecek");
    }

    // 8. SCROLL - YORUM SAYISI BAZLI (Bellek için max scroll azalt, delay optimize)
    console.log("📜 Scroll başlatılıyor...");
    let lastReviewCount = 0;
    let sameCountStreak = 0;
    const SAME_LIMIT = 10; // Daha yüksek limit
    const MAX_SCROLL = 300; // Azaltıldı
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
        if (!container) return { reviews: 0 };
        container.scrollTop = container.scrollHeight;
        const reviewCount = Math.max(
          document.querySelectorAll('[data-review-id]').length,
          document.querySelectorAll('.jftiEf').length,
          document.querySelectorAll('div[role="article"]').length,
          document.querySelectorAll('.MyEned').length
        );
        return { reviews: reviewCount };
      });
      await delay(800); // Delay azaltıldı
      if (reviews === lastReviewCount) {
        sameCountStreak++;
      } else {
        sameCountStreak = 0;
      }
      lastReviewCount = reviews;
      if (i % 20 === 0) { // Log sıklığı azalt
        console.log(`📊 Scroll ${i} | Yorum: ${reviews} | Sabit: ${sameCountStreak}`);
      }
      if (sameCountStreak >= SAME_LIMIT && i > 20) {
        console.log("🛑 Yorum sayısı artmıyor, durduruluyor");
        break;
      }
    }
    console.log(`✅ Scroll tamamlandı | Son yorum sayısı: ${lastReviewCount}`);
    await delay(3000);

    // 9. YORUMLARI ÇEK (Duplikat için uniqueKey güçlendirildi)
    console.log("🔍 Yorumlar parse ediliyor...");
    const reviews = await page.evaluate(async () => {
      const results = [];
      const seenKeys = new Set();

      // Tüm yorum kartlarını bul
      const reviewSelectors = [
        'div[role="article"]',
        '[data-review-id]',
        '.jftiEf',
        '.MyEned'
      ];
      let reviewElements = [];
      for (const selector of reviewSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > reviewElements.length) {
          reviewElements = Array.from(elements);
        }
      }
      console.log(`📝 ${reviewElements.length} yorum kartı bulundu`);

      // "Daha fazla" butonlarına tıkla (Bellek için batch yap)
      for (let j = 0; j < reviewElements.length; j += 10) { // Batch
        const batch = reviewElements.slice(j, j + 10);
        for (const card of batch) {
          const expandBtns = card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe');
          for (const btn of expandBtns) {
            if (btn && btn.offsetHeight > 0) {
              try {
                btn.click();
                await new Promise(r => setTimeout(r, 30));
              } catch (e) {}
            }
          }
        }
        await new Promise(r => setTimeout(r, 500)); // Küçük delay
      }

      // Yorumları parse et
      reviewElements.forEach((card, index) => {
        try {
          // Yıldız bul
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
          if (starEl) {
            const match = starEl.getAttribute('aria-label')?.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }

          // Sadece 1-2 yıldız
          if (!rating || rating > 2) return;

          // Yorum metni
          let text = '';
          const textEl = card.querySelector('.wiI7pd, span[data-expandable-section]');
          if (textEl) text = textEl.textContent?.trim() || '';

          // Yazar
          let author = 'Anonim';
          const authorEl = card.querySelector('.d4r55');
          if (authorEl) {
            author = authorEl.textContent?.trim().split('·')[0].trim() || 'Anonim';
          }

          // Duplikat kontrolü (Güçlendirildi: text + author + rating)
          const hasText = text.length > 0;
          const uniqueKey = `${rating}_${author}_${text.substring(0, 100)}`; // Daha uzun substring
          if (seenKeys.has(uniqueKey)) return;
          seenKeys.add(uniqueKey);

          results.push({ rating, text, author, hasReview: hasText });
        } catch (e) {
          console.error(`Parse error ${index}:`, e.message);
        }
      });

      return results;
    });

    console.log(`✅ Toplam ${reviews.length} adet 1-2 yıldızlı yorum çekildi`);

    // İstatistikler
    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);
    console.log(`⭐ 1 yıldız: ${oneStar.length}`);
    console.log(`⭐ 2 yıldız: ${twoStar.length}`);

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
