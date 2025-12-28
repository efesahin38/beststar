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

    // STRATEJİ 1: Place link bekle (kısa timeout)
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

          // İlk 3 linki kontrol et
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

    // STRATEJİ 2: Kart selectors
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
          finalPlaceUrl = placeUrl;
          await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          placeFound = true;
          await delay(6000);
        }
      } catch (e) {
        console.log("⚠️ Strateji 3 başarısız");
      }
    }

    // STRATEJİ 4: Koordinat tıklama
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
    // 4. İŞLETME BİLGİLERİNİ AL - DOĞRU ADRES GARANTİLİ
    // ==========================================
    console.log("📋 İşletme bilgileri alınıyor...");
    
    // İsim için bekle
    await page.waitForSelector('h1.DUwDvf, h1', { timeout: 15000 }).catch(() => 
      console.log("⚠️ H1 bulunamadı")
    );
    await delay(3000);
    
    const businessInfo = await page.evaluate(() => {
      // İSİM
      let name = 'İşletme adı bulunamadı';
      const nameSelectors = ['h1.DUwDvf', 'h1.DUwDvf.lfPIob', 'h1'];
      for (const sel of nameSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 0) {
          name = el.innerText.trim();
          break;
        }
      }
      
      console.log('[DEBUG] İşletme adı:', name);
      
      // ADRES - GOOGLE MAPS GERÇEK YAPISINA GÖRE
      let address = 'Adres bulunamadı';
      let foundMethod = 'none';
      
      // YÖNTEM 1: data-item-id="address" - EN KESİN
      try {
        const addressBtn = document.querySelector('button[data-item-id="address"]');
        if (addressBtn) {
          // İçindeki tüm text node'ları al (aria-label değil, gerçek text)
          const text = addressBtn.textContent?.trim() || addressBtn.innerText?.trim() || '';
          // Sadece görünen kısmı al (Copy address kısmını çıkar)
          const cleanText = text.split('Copy address')[0].trim();
          if (cleanText.length >= 10 && /\d/.test(cleanText)) {
            address = cleanText;
            foundMethod = 'data-item-id-button';
            console.log('[DEBUG] ✅ Adres bulundu (data-item-id button):', address);
          }
        }
      } catch (e) {
        console.log('[DEBUG] Yöntem 1 hata:', e.message);
      }
      
      // YÖNTEM 2: Adres butonunun yakınındaki div'leri kontrol et
      if (address === 'Adres bulunamadı') {
        try {
          // Adres butonu varsa, onun parent'ındaki div'lere bak
          const addressSection = document.querySelector('button[data-item-id="address"]')?.closest('div[class*="Io6YTe"]');
          if (addressSection) {
            const divs = addressSection.querySelectorAll('div');
            for (const div of divs) {
              const text = div.textContent?.trim() || '';
              // Kısa, rakam içeren, copy address içermeyen
              if (text.length >= 10 && text.length <= 150 && /\d/.test(text) && !text.includes('Copy') && !text.includes('address')) {
                address = text;
                foundMethod = 'address-section-div';
                console.log('[DEBUG] ✅ Adres bulundu (address section):', address);
                break;
              }
            }
          }
        } catch (e) {
          console.log('[DEBUG] Yöntem 2 hata:', e.message);
        }
      }
      
      // YÖNTEM 3: Yan paneldeki tüm butonları tara, aria-label'a göre filtrele
      if (address === 'Adres bulunamadı') {
        try {
          const sidePanel = document.querySelector('div[role="main"]') || document.body;
          const allButtons = Array.from(sidePanel.querySelectorAll('button'));
          
          console.log('[DEBUG] Toplam buton:', allButtons.length);
          
          for (let i = 0; i < allButtons.length; i++) {
            const btn = allButtons[i];
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const text = (btn.textContent || '').trim();
            
            // Aria-label "Address:" veya "Adres:" ile başlıyorsa
            if (ariaLabel.match(/^(Address|Adres):/i)) {
              // Text'ten ilk satırı al (genelde adrestir)
              const lines = text.split('\n').filter(l => l.trim());
              const firstLine = lines[0]?.trim() || '';
              
              if (firstLine.length >= 10 && /\d/.test(firstLine) && !firstLine.includes('Copy')) {
                address = firstLine;
                foundMethod = `aria-label-address-${i}`;
                console.log('[DEBUG] ✅ Adres bulundu (aria-label):', address);
                break;
              }
            }
            
            // Text adres pattern'ine uyuyorsa
            if (text.length >= 15 && text.length <= 150 && /\d/.test(text)) {
              // Telefon değil, isim değil
              if (!text.includes('+') && text !== name) {
                // Adres kelimeleri içeriyor mu?
                const hasAddressWord = /straße|strasse|str\.|street|st\.|avenue|ave\.|road|rd\.|platz|weg|sokak|cadde|bulvar/i.test(text);
                // Veya posta kodu var mı?
                const hasPostalCode = /\b\d{5}\b/.test(text);
                // Veya virgülle ayrılmış mı? (Sokak, Şehir)
                const hasComma = text.includes(',');
                
                if (hasAddressWord || hasPostalCode || hasComma) {
                  address = text.split('\n')[0].trim(); // İlk satırı al
                  foundMethod = `button-pattern-${i}`;
                  console.log('[DEBUG] ✅ Adres bulundu (button pattern):', address);
                  break;
                }
              }
            }
          }
        } catch (e) {
          console.log('[DEBUG] Yöntem 3 hata:', e.message);
        }
      }
      
      // YÖNTEM 4: XPath ile adres ikonu olan elementi bul
      if (address === 'Adres bulunamadı') {
        try {
          // Adres ikonu genelde bir img veya svg içerir
          const addressIcons = document.querySelectorAll('img[src*="place"], img[src*="pin"], svg[aria-label*="address" i]');
          for (const icon of addressIcons) {
            const parent = icon.closest('button') || icon.closest('div');
            if (parent) {
              const text = (parent.textContent || '').trim();
              if (text.length >= 10 && text.length <= 150 && /\d/.test(text) && !text.includes('+')) {
                address = text.split('\n')[0].trim();
                foundMethod = 'address-icon';
                console.log('[DEBUG] ✅ Adres bulundu (icon):', address);
                break;
              }
            }
          }
        } catch (e) {
          console.log('[DEBUG] Yöntem 4 hata:', e.message);
        }
      }
      
      // YÖNTEM 5: Sayfa HTML'ini tara (son çare)
      if (address === 'Adres bulunamadı') {
        try {
          const bodyText = document.body.innerText;
          const lines = bodyText.split('\n');
          
          for (const line of lines) {
            const trimmed = line.trim();
            // Adres pattern'i: 10-100 karakter, rakam içeren, telefon değil
            if (trimmed.length >= 10 && trimmed.length <= 100 && /\d/.test(trimmed) && !trimmed.includes('+')) {
              // Posta kodu veya adres kelimesi var mı?
              const hasPostal = /\b\d{5}\b/.test(trimmed);
              const hasAddressWord = /straße|strasse|str\.|street|avenue|road|platz|weg|sokak|cadde/i.test(trimmed);
              const hasComma = trimmed.includes(',');
              
              if ((hasPostal || hasAddressWord || hasComma) && trimmed !== name) {
                address = trimmed;
                foundMethod = 'body-text-scan';
                console.log('[DEBUG] ✅ Adres bulundu (body scan):', address);
                break;
              }
            }
          }
        } catch (e) {
          console.log('[DEBUG] Yöntem 5 hata:', e.message);
        }
      }
      
      console.log('[DEBUG] Final adres:', address);
      console.log('[DEBUG] Bulunma yöntemi:', foundMethod);
      
      return { name, address, addressMethod: foundMethod };
    });
    
    console.log("🏢 İşletme:", businessInfo.name);
    console.log("📍 Adres:", businessInfo.address);
    console.log("🔍 Adres yöntemi:", businessInfo.addressMethod);

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
        
        // En düşük puanlı seç
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
    // 7. SCROLL - TÜM 1-2 YILDIZLARI ÇEK
    // ==========================================
    console.log("📜 Scroll başlatılıyor (TÜM 1-2 yıldızlı yorumlar çekilecek)...");
    
    let oneTwoStarCount = 0;
    let lastOneTwoStarCount = 0;
    let stableStreak = 0;
    let scrollCount = 0;
    let threeStarAppeared = false;
    const MAX_SCROLL = 250;
    const STABLE_LIMIT = 15;
    
    for (let i = 0; i < MAX_SCROLL; i++) {
      const { totalReviews, oneTwoStars, hasThreeStar } = await page.evaluate(() => {
        // Scroll container'ı bul
        const container = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
                          document.querySelector('.m6QErb') ||
                          document.querySelector('div[role="region"]') ||
                          document.querySelector('[role="main"]');
        
        if (!container) return { totalReviews: 0, oneTwoStars: 0, hasThreeStar: false };
        
        // Scroll yap
        container.scrollTop = container.scrollHeight;
        
        // Yorum elementlerini say
        const reviewElements = document.querySelectorAll('[data-review-id], .jftiEf');
        
        let oneTwoCount = 0;
        let hasThree = false;
        
        reviewElements.forEach(card => {
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i], [role="img"][aria-label*="Stern" i]');
          if (starEl) {
            const ariaLabel = starEl.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+)/);
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
      
      // 3 yıldız takibi
      if (hasThreeStar && !threeStarAppeared) {
        console.log("⭐ 3 yıldızlı yorum görüldü (devam ediliyor)");
        threeStarAppeared = true;
      }
      
      // 1-2 yıldız sayısı değişti mi?
      if (oneTwoStarCount === lastOneTwoStarCount) {
        stableStreak++;
      } else {
        stableStreak = 0;
      }
      lastOneTwoStarCount = oneTwoStarCount;
      
      // Log
      if (i % 10 === 0) {
        console.log(`📊 Scroll ${i} | Toplam: ${totalReviews} | 1-2⭐: ${oneTwoStarCount} | Sabit: ${stableStreak}`);
      }
      
      // Durma kriterleri
      if (stableStreak >= STABLE_LIMIT && oneTwoStarCount >= 5) {
        console.log("🛑 1-2 yıldız artık çıkmıyor, tamamlandı!");
        break;
      }
      
      await delay(600 + Math.random() * 250);
    }
    
    console.log(`✅ Scroll tamamlandı | ${scrollCount} iterasyon | ${oneTwoStarCount} adet 1-2⭐`);
    await delay(2000);

    // ==========================================
    // 8. YORUMLARI PARSE ET
    // ==========================================
    console.log("🔍 Yorumlar parse ediliyor...");
    
    // Expand butonlarını tıkla
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
              if (btn.offsetHeight > 0) btn.click();
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
      
      reviewElements.forEach((card) => {
        try {
          // Yıldız
          let rating = null;
          const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i], [role="img"][aria-label*="Stern" i]');
          if (starEl) {
            const ariaLabel = starEl.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+)/);
            if (match) rating = parseInt(match[1]);
          }
          
          if (!rating || rating > 2) return;
          
          // Metin
          let text = '';
          const textSelectors = ['.wiI7pd', 'span[data-expandable-section]', '.MyEned', 'span[jsan]'];
          for (const sel of textSelectors) {
            const textEl = card.querySelector(sel);
            if (textEl && textEl.textContent) {
              text = textEl.textContent.trim();
              if (text.length > 10) break;
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
          
          // Hash ile unique kontrol
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
        } catch (e) {}
      });
      
      return results;
    });

    console.log(`✅ ${reviews.length} adet 1-2 yıldızlı yorum parse edildi`);

    const oneStar = reviews.filter(r => r.rating === 1);
    const twoStar = reviews.filter(r => r.rating === 2);

    console.log(`📊 1⭐: ${oneStar.length} | 2⭐: ${twoStar.length}`);

    // ==========================================
    // 9. RESPONSE GÖNDER
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
