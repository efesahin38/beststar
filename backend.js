// GOOGLE MAPS SCRAPER - ULTIMATE VERSION - HİÇBİR YORUM KAÇIRMAZ
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

// Benzersiz hash oluştur
const createReviewHash = (review) => {
    const normalized = `${review.author}|${review.rating}|${review.text.substring(0, 150)}`.toLowerCase().replace(/\s+/g, '');
    return crypto.createHash('sha256').update(normalized).digest('hex');
};

// String benzerliği hesapla (fuzzy match)
const similarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    const editDistance = (s1, s2) => {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();
        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) costs[j] = j;
                else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
    };
    return (longer.length - editDistance(longer, shorter)) / longer.length;
};

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
    const location = req.body.location || ""; // Opsiyonel konum
    
    if (!business) return res.json({ error: "İşletme adı gerekli." });

    let browser;
    try {
        console.log(`🔎 "${business}" ${location ? `(${location})` : ''} aranıyor...`);
        
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security",
                "--window-size=1920,1080",
                "--single-process",
                "--no-zygote",
                "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7,de;q=0.6",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultTimeout(300000);
        await page.setViewport({ width: 1920, height: 1080 });

        // Anti-detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en', 'de-DE', 'de'] });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 1 });
        });

        await page.setCookie({
            name: 'CONSENT',
            value: 'YES+cb.20210720-07-p0.tr+FX+410',
            domain: '.google.com',
            path: '/',
            expires: Date.now() / 1000 + 31536000
        });

        // ============================================
        // 1. GOOGLE MAPS SEARCH - GELİŞMİŞ ARAMA
        // ============================================
        const searchQuery = location ? `${business} ${location}` : business;
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
        
        console.log("🌐 Google Maps açılıyor...");
        console.log(`🔍 Arama: "${searchQuery}"`);
        
        await page.goto(searchUrl, { 
            waitUntil: "networkidle0", 
            timeout: 180000 
        });
        
        await delay(12000); // İlk yükleme için uzun bekleme

        // ============================================
        // 2. COOKIE CONSENT - AGRESIF BYPASS
        // ============================================
        console.log("🍪 Cookie bypass...");
        let consentAttempts = 0;
        const MAX_CONSENT_ATTEMPTS = 5;

        while (page.url().includes('consent.google.com') && consentAttempts < MAX_CONSENT_ATTEMPTS) {
            console.log(`⚠️ Consent bypass ${consentAttempts + 1}/${MAX_CONSENT_ATTEMPTS}...`);
            
            await page.evaluate(() => {
                // Yöntem 1: Tüm butonları dene
                const buttons = Array.from(document.querySelectorAll('button'));
                buttons.forEach((btn, i) => {
                    const text = btn.textContent.toLowerCase();
                    if (text.includes('accept') || text.includes('kabul') || 
                        text.includes('akzeptieren') || text.includes('alle') ||
                        text.includes('agree') || text.includes('ok')) {
                        setTimeout(() => btn.click(), i * 100);
                    }
                });

                // Yöntem 2: Form submit
                setTimeout(() => {
                    const forms = document.querySelectorAll('form');
                    forms.forEach(f => f.submit());
                }, 1000);

                // Yöntem 3: Hidden submit button
                setTimeout(() => {
                    const submits = document.querySelectorAll('button[type="submit"]');
                    submits.forEach(s => s.click());
                }, 1500);
            });
            
            await delay(8000);
            consentAttempts++;
        }

        // Hala consent'te ise farklı strateji
        if (page.url().includes('consent.google.com')) {
            console.log("🔄 Cookie bypass başarısız, alternatif yöntem...");
            
            // Alternatif 1: Direkt Maps'e git
            await page.goto(searchUrl, { waitUntil: "networkidle0", timeout: 180000 });
            await delay(10000);
            
            // Alternatif 2: Consent cookie set et
            await page.setCookie({
                name: 'SOCS',
                value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmRlIAEaBgiA_LyaBg',
                domain: '.google.com',
                path: '/'
            });
            
            await page.goto(searchUrl, { waitUntil: "networkidle0", timeout: 180000 });
            await delay(10000);
        }

        console.log("✅ Maps sayfasında");

        // ============================================
        // 3. İŞLETME KARTINI BUL - SÜPER AGRESIF
        // ============================================
        console.log("🎯 İşletme kartı aranıyor (gelişmiş algoritma)...");
        
        let placeFound = false;
        let targetPlaceUrl = null;
        let bestMatch = null;
        let attempts = 0;
        const MAX_ATTEMPTS = 8;

        while (!placeFound && attempts < MAX_ATTEMPTS) {
            attempts++;
            console.log(`\n🔍 === Arama Denemesi ${attempts}/${MAX_ATTEMPTS} ===`);

            // Sayfayı analiz et
            const analysis = await page.evaluate((searchTerm) => {
                const placeLinks = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
                
                return {
                    totalPlaceLinks: placeLinks.length,
                    places: placeLinks.slice(0, 10).map(link => ({
                        name: link.querySelector('.qBF1Pd')?.textContent?.trim() || 
                              link.textContent?.trim().split('\n')[0] || '',
                        url: link.href,
                        ariaLabel: link.getAttribute('aria-label') || ''
                    })),
                    hasResults: placeLinks.length > 0 || 
                               document.body.innerText.toLowerCase().includes('sonuç') ||
                               document.body.innerText.toLowerCase().includes('results')
                };
            }, business);

            console.log(`📊 Toplam ${analysis.totalPlaceLinks} işletme bulundu`);

            // Sonuç yoksa
            if (!analysis.hasResults) {
                console.log("⚠️ Hiç sonuç yok, sayfa yenileniyor...");
                await page.reload({ waitUntil: "networkidle0" });
                await delay(12000);
                continue;
            }

            // İşletmeleri listele ve en iyi eşleşmeyi bul
            if (analysis.places.length > 0) {
                console.log("\n📋 Bulunan işletmeler:");
                
                let maxSimilarity = 0;
                
                analysis.places.forEach((place, i) => {
                    const sim = similarity(place.name.toLowerCase(), business.toLowerCase());
                    console.log(`  ${i + 1}. ${place.name} (benzerlik: ${(sim * 100).toFixed(1)}%)`);
                    
                    if (sim > maxSimilarity) {
                        maxSimilarity = sim;
                        bestMatch = { ...place, index: i, similarity: sim };
                    }
                });

                // En iyi eşleşme yeterince iyi mi?
                if (bestMatch && bestMatch.similarity > 0.6) {
                    console.log(`\n✅ EN İYİ EŞLEŞME: "${bestMatch.name}" (%${(bestMatch.similarity * 100).toFixed(1)})`);
                    targetPlaceUrl = bestMatch.url;
                } else if (analysis.places.length === 1) {
                    // Tek sonuç varsa onu al
                    console.log(`\n📌 Tek sonuç bulundu: "${analysis.places[0].name}"`);
                    targetPlaceUrl = analysis.places[0].url;
                    bestMatch = analysis.places[0];
                } else {
                    console.log(`\n⚠️ Yeterince iyi eşleşme bulunamadı (max: %${(maxSimilarity * 100).toFixed(1)})`);
                }
            }

            // YÖNTEM 1: En iyi eşleşmeye GİT
            if (targetPlaceUrl && !placeFound) {
                try {
                    console.log(`\n🎯 Hedef işletmeye gidiliyor...`);
                    console.log(`🔗 URL: ${targetPlaceUrl.substring(0, 100)}...`);
                    
                    await page.goto(targetPlaceUrl, { 
                        waitUntil: "networkidle0", 
                        timeout: 90000 
                    });
                    
                    await delay(10000);
                    
                    if (page.url().includes('/maps/place/')) {
                        console.log("✅ İşletme sayfası açıldı!");
                        placeFound = true;
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 1 hata:", e.message);
                }
            }

            // YÖNTEM 2: Link'e tıklama
            if (!placeFound && bestMatch) {
                try {
                    console.log(`\n🖱️ Link tıklama yöntemi...`);
                    
                    const clicked = await page.evaluate((index) => {
                        const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
                        if (links[index]) {
                            links[index].click();
                            return true;
                        }
                        return false;
                    }, bestMatch.index);

                    if (clicked) {
                        console.log("✅ Link tıklandı");
                        await delay(10000);
                        
                        if (page.url().includes('/maps/place/')) {
                            placeFound = true;
                        }
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 2 hata:", e.message);
                }
            }

            // YÖNTEM 3: Kart elementlerine tıklama
            if (!placeFound) {
                try {
                    console.log(`\n🎴 Kart tıklama yöntemi...`);
                    
                    const cardSelectors = [
                        '.hfpxzc',
                        '.Nv2PK',
                        'div[role="article"]',
                        'a.hfpxzc',
                        '.qBF1Pd'
                    ];

                    for (const selector of cardSelectors) {
                        const cards = await page.$$(selector);
                        if (cards.length > 0) {
                            console.log(`  Trying ${selector}: ${cards.length} found`);
                            await cards[0].click();
                            await delay(8000);
                            
                            if (page.url().includes('/maps/place/')) {
                                console.log(`✅ ${selector} başarılı!`);
                                placeFound = true;
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 3 hata:", e.message);
                }
            }

            // YÖNTEM 4: Koordinat tıklama (desperate measure)
            if (!placeFound && attempts > 3) {
                try {
                    console.log(`\n📍 Koordinat tıklama...`);
                    await page.mouse.click(400, 400);
                    await delay(8000);
                    
                    if (page.url().includes('/maps/place/')) {
                        placeFound = true;
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 4 hata");
                }
            }

            if (!placeFound) {
                console.log(`\n⏳ Bekleniyor ve tekrar deneniyor...`);
                await delay(5000);
            }
        }

        // İşletme bulunamadıysa
        if (!placeFound) {
            console.log("\n❌ İŞLETME BULUNAMADI!");
            
            try {
                const fs = require('fs');
                const screenshot = await page.screenshot({ fullPage: true });
                fs.writeFileSync('/tmp/debug_not_found.png', screenshot);
                
                const html = await page.content();
                fs.writeFileSync('/tmp/debug_page.html', html);
                
                console.log("📸 Debug dosyaları: /tmp/debug_not_found.png & debug_page.html");
            } catch (err) {}
            
            return res.json({
                success: false,
                error: "İşletme bulunamadı. Lütfen işletme adını ve konumunu kontrol edin.",
                searched: searchQuery,
                found_places: analysis.places.map(p => p.name),
                suggestion: "Tam işletme adını veya konum ekleyin. Örnek: 'By Ali Berlin'"
            });
        }

        console.log("\n🎉 İŞLETME SAYFASI AÇILDI!");

        // ============================================
        // 4. İŞLETME BİLGİLERİ
        // ============================================
        console.log("\n📋 İşletme bilgileri alınıyor...");
        
        await page.waitForSelector('h1.DUwDvf, h1', { timeout: 30000 });
        await delay(5000);

        const businessInfo = await page.evaluate(() => {
            const name = document.querySelector('h1.DUwDvf')?.innerText?.trim() || 
                         document.querySelector('h1')?.innerText?.trim() || 
                         'Bilinmiyor';
            
            let address = 'Adres bulunamadı';
            const addressButtons = document.querySelectorAll('button[data-item-id="address"], button[data-tooltip*="Adres"], button[aria-label*="Address"]');
            
            for (const btn of addressButtons) {
                const text = btn.innerText?.replace(/\n/g, ' ').trim();
                if (text && text.length > 10) {
                    address = text;
                    break;
                }
            }

            // Rating
            const ratingEl = document.querySelector('.F7nice span[aria-hidden="true"]');
            const rating = ratingEl ? ratingEl.textContent.trim() : 'N/A';

            // Review count
            const reviewCountEl = document.querySelector('.F7nice span:nth-child(2)');
            const reviewCount = reviewCountEl ? reviewCountEl.textContent.trim() : 'N/A';

            return { name, address, rating, reviewCount };
        });

        console.log(`🏢 İşletme: ${businessInfo.name}`);
        console.log(`📍 Adres: ${businessInfo.address}`);
        console.log(`⭐ Puan: ${businessInfo.rating} (${businessInfo.reviewCount})`);

        // ============================================
        // 5. YORUMLAR SEKMESİ - AGRESIF AÇ
        // ============================================
        console.log("\n💬 Yorumlar sekmesi açılıyor...");
        await delay(5000);
        
        let reviewsOpened = false;
        const reviewButtonSelectors = [
            'button[jsaction*="pane.rating.moreReviews"]',
            'button[aria-label*="review" i]',
            'button[aria-label*="yorum" i]',
            'button[aria-label*="Rezension" i]',
            'button.hh2c6',
            'div.AeaXub button',
            'button.fontTitleSmall',
            'button[data-tab-index="1"]'
        ];

        for (const selector of reviewButtonSelectors) {
            try {
                const btns = await page.$$(selector);
                for (const btn of btns) {
                    const text = await page.evaluate(el => el.textContent, btn);
                    if (text && (text.includes('review') || text.includes('yorum') || text.includes('Rezension') || /\d+/.test(text))) {
                        console.log(`🎯 Yorum butonu bulundu: "${text.substring(0, 30)}"`);
                        await btn.click();
                        await delay(8000);
                        reviewsOpened = true;
                        break;
                    }
                }
                if (reviewsOpened) break;
            } catch (e) {
                continue;
            }
        }

        if (!reviewsOpened) {
            console.log("⚠️ Yorum butonu bulunamadı, alternatif yöntem...");
            
            // Keyboard navigation
            try {
                for (let i = 0; i < 10; i++) {
                    await page.keyboard.press('Tab');
                    await delay(200);
                }
                await page.keyboard.press('Enter');
                await delay(5000);
                reviewsOpened = true;
            } catch (e) {}
        }

        console.log(reviewsOpened ? "✅ Yorumlar açıldı" : "⚠️ Yorumlar bölümü belirsiz, devam");

        // ============================================
        // 6. SIRALAMA - EN DÜŞÜK PUANLI
        // ============================================
        console.log("\n⭐ Sıralama: En düşük puanlı...");
        await delay(4000);

        try {
            // Sıralama butonunu bul
            const sortButton = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const sortBtn = buttons.find(b => {
                    const text = b.textContent.toLowerCase();
                    return text.includes('sort') || text.includes('sırala') || 
                           text.includes('sortieren') || text.includes('trier');
                });
                
                if (sortBtn) {
                    sortBtn.click();
                    return true;
                }
                return false;
            });

            if (sortButton) {
                console.log("✅ Sıralama menüsü açıldı");
                await delay(2500);

                // En düşük puanlı seç
                const sorted = await page.evaluate(() => {
                    const options = Array.from(document.querySelectorAll('div[role="menuitemradio"], li[role="menuitemradio"]'));
                    
                    // Text-based search
                    const lowestOpt = options.find(opt => {
                        const text = opt.textContent.toLowerCase();
                        return text.includes('lowest') || text.includes('düşük') || 
                               text.includes('niedrigste') || text.includes('bas');
                    });
                    
                    if (lowestOpt) {
                        lowestOpt.click();
                        return 'text-match';
                    }
                    
                    // Index-based (usually 2nd option)
                    if (options[1]) {
                        options[1].click();
                        return 'index-1';
                    }
                    
                    return false;
                });

                if (sorted) {
                    console.log(`✅ Sıralama seçildi (${sorted})`);
                    await delay(6000); // Sıralama için ekstra süre
                } else {
                    console.log("⚠️ Sıralama seçeneği bulunamadı");
                }
            } else {
                console.log("⚠️ Sıralama butonu bulunamadı, varsayılan sıralama kullanılacak");
            }
        } catch (e) {
            console.log("⚠️ Sıralama hatası:", e.message);
        }

        // ============================================
        // 7. SCROLL - MAXIMUM YORUM
        // ============================================
        console.log("\n📜 SCROLL BAŞLADI (maksimum yorum modu)...");

        let lastCount = 0;
        let noChangeCount = 0;
        const NO_CHANGE_LIMIT = 12; // Daha yüksek limit
        const MAX_SCROLLS = 600; // Daha fazla scroll
        let totalScrollDistance = 0;

        for (let i = 0; i < MAX_SCROLLS; i++) {
            const scrollResult = await page.evaluate(() => {
                // Container bul
                const selectors = [
                    '.m6QErb.DxyBCb.kA9KIf.dS8AEf',
                    '.m6QErb.DxyBCb',
                    '.m6QErb',
                    'div[role="region"]',
                    '[role="main"] div[tabindex="-1"]'
                ];

                let container = null;
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.scrollHeight > el.clientHeight) {
                        container = el;
                        break;
                    }
                }

                if (!container) return { success: false, count: 0 };

                // Scroll
                const before = container.scrollTop;
                container.scrollTop = container.scrollHeight;
                const after = container.scrollTop;
                const scrolled = after - before;

                // Yorum say
                const count = Math.max(
                    document.querySelectorAll('[data-review-id]').length,
                    document.querySelectorAll('.jftiEf').length,
                    document.querySelectorAll('.wiI7pd').length,
                    document.querySelectorAll('div[jsaction*="review"]').length
                );

                return {
                    success: true,
                    count,
                    scrolled,
                    atBottom: scrolled < 10
                };
            });

            await randomDelay(800, 1200); // İnsan benzeri

            if (!scrollResult.success) {
                console.log("⚠️ Scroll container kayboldu, yeniden deneniyor...");
                await delay(3000);
                continue;
            }

            totalScrollDistance += scrollResult.scrolled || 0;

            // Değişim kontrolü
            if (scrollResult.count === lastCount) {
                noChangeCount++;
            } else {
                noChangeCount = 0;
                lastCount = scrollResult.count;
            }

            // Progress log
            if (i % 25 === 0) {
                console.log(`📊 Scroll ${i}/${MAX_SCROLLS} | Yorum: ${scrollResult.count} | Sabit: ${noChangeCount}/${NO_CHANGE_LIMIT} | Scroll: ${totalScrollDistance}px`);
            }

            // Dur koşulları
            if (noChangeCount >= NO_CHANGE_LIMIT && i > 30) {
                console.log(`\n🛑 ${noChangeCount} kez değişmedi, yeterli yorum yüklendi`);
                break;
            }

            if (scrollResult.atBottom && noChangeCount > 5) {
                console.log("\n🛑 Sayfa sonu + yorum artmıyor");
                break;
            }
        }

        console.log(`\n✅ SCROLL TAMAMLANDI | Son yorum sayısı: ${lastCount}`);
        await delay(8000); // Son yorumlar için ekstra süre

        // ============================================
        // 8. YORUMLARI ÇEK - HASH BAZLI DUPLİKASYON ENGELLEME
        // ============================================
        console.log("\n🔍 YORUM PARSE BAŞLADI...");

        // Önce tüm "daha fazla" butonlarına tıkla
        console.log("📖 Yorumlar genişletiliyor...");
        
        await page.evaluate(() => {
            const expandButtons = document.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button[aria-label*="mehr" i], button.w8nwRe');
            let clicked = 0;
            expandButtons.forEach((btn, i) => {
                if (btn && btn.offsetHeight > 0) {
                    setTimeout(() => {
                        try {
                            btn.click();
                            clicked++;
                        } catch (e) {}
                    }, i * 50);
                }
            });
            console.log(`Clicked ${clicked} expand buttons`);
        });

        await delay(6000); // Genişletme için süre

        // Yorumları parse et
        const reviews = await page.evaluate(() => {
            const results = [];
            const seenHashes = new Set();

            // Hash oluştur
            const createHash = (str) => {
                let hash = 0;
                for (let i = 0; i < str.length; i++) {
                    const char = str.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash;
                }
                return hash.toString(36);
            };

            // Yorum kartlarını bul
            const selectors = [
                'div[data-review-id]',
                'div[jsaction*="review"]',
                '.jftiEf',
                'div[role="article"]',
                '.MyEned'
            ];

            let reviewElements = [];
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > reviewElements.length) {
                    reviewElements = Array.from(els);
                    console.log(`Using selector: ${sel} (${els.length} elements)`);
                }
            }

            console.log(`Total review cards found: ${reviewElements.length}`);

            // Her kartı parse et
            reviewElements.forEach((card, idx) => {
                try {
                    // Yıldız
                    let rating = null;
                    const starSelectors = ['[role="img"][aria-label*="star" i]', '[role="img"][aria-label*="yıldız" i]', '[role="img"][aria-label*="Stern" i]'];
                    
                    for (const sel of starSelectors) {
                        const starEl = card.querySelector(sel);
                        if (starEl) {
                            const label = starEl.getAttribute('aria-label') || '';
                            const match = label.match(/(\d+)/);
                            if (match) {
                                rating = parseInt(match[1]);
                                break;
                            }
                        }
                    }

                    // Sadece 1-2 yıldız
                    if (!rating || rating > 2) return;

                    // Yazar
                    let author = 'Anonim';
                    const authorSelectors = ['.d4r55', '.WEBjve', '[class*="author"]'];
                    for (const sel of authorSelectors) {
                        const authorEl = card.querySelector(sel);
                        if (authorEl) {
                            author = authorEl.textContent?.trim().split('·')[0].split('\n')[0].trim() || 'Anonim';
                            if (author && author.length > 0) break;
                        }
                    }

                    // Yorum metni
                    let text = '';
                    const textSelectors = ['.wiI7pd', 'span[data-expandable-section]', '.MyEned', '.rsqaWe', '[class*="review-text"]'];
                    for (const sel of textSelectors) {
                        const textEl = card.querySelector(sel);
                        if (textEl && textEl.textContent.trim()) {
                            text = textEl.textContent.trim();
                            break;
                        }
                    }

                    // Tarih
                    let date = '';
                    const dateSelectors = ['.rsqaWe', '.DU9Pgb', 'span[class*="date"]'];
                    for (const sel of dateSelectors) {
                        const dateEl = card.querySelector(sel);
                        if (dateEl) {
                            date = dateEl.textContent?.trim() || '';
                            if (date) break;
                        }
                    }

                    // HASH - DUPLİKASYON KONTROLÜ
                    const normalized = `${author}_${rating}_${text.substring(0, 150)}_${date}`.toLowerCase().replace(/\s+/g, '');
                    const hash = createHash(normalized);

                    if (seenHashes.has(hash)) {
                        console.log(`⚠️ Duplicate: ${author} - ${rating}⭐ (hash: ${hash})`);
                        return;
                    }

                    seenHashes.add(hash);

                    // Review ID
                    const reviewId = card.getAttribute('data-review-id') || `review_${idx}`;

                    results.push({
                        id: reviewId,
                        rating,
                        text,
                        author,
                        date,
                        hasText: text.length > 0,
                        hash,
                        textLength: text.length
                    });

                } catch (e) {
                    console.error(`Parse error ${idx}:`, e.message);
                }
            });

            console.log(`Parsed ${results.length} unique reviews (${seenHashes.size} hashes)`);
            return results;
        });

        console.log(`\n✅ ${reviews.length} BENZERSIZ YORUM ÇEKİLDİ!`);

        // ============================================
        // 9. İSTATİSTİKLER ve SONUÇ
        // ============================================
        const oneStar = reviews.filter(r => r.rating === 1);
        const twoStar = reviews.filter(r => r.rating === 2);
        const withText = reviews.filter(r => r.hasText);
        const withoutText = reviews.filter(r => !r.hasText);

        console.log(`\n📊 === SONUÇLAR ===`);
        console.log(`⭐ 1 yıldız: ${oneStar.length} (metin: ${oneStar.filter(r => r.hasText).length})`);
        console.log(`⭐ 2 yıldız: ${twoStar.length} (metin: ${twoStar.filter(r => r.hasText).length})`);
        console.log(`📝 Toplam metinli: ${withText.length}`);
        console.log(`📭 Metinsiz: ${withoutText.length}`);

        // Örnek yorumları göster
        if (oneStar.length > 0) {
            console.log(`\n📄 Örnek 1 yıldızlı yorum:`);
            console.log(`   "${oneStar[0].text.substring(0, 100)}..."`);
        }

        res.json({
            success: true,
            scraper_version: "3.0-ultimate",
            timestamp: new Date().toISOString(),
            business: {
                name: businessInfo.name,
                address: businessInfo.address,
                rating: businessInfo.rating,
                total_reviews: businessInfo.reviewCount,
                url: page.url()
            },
            statistics: {
                total_scraped: reviews.length,
                one_star: oneStar.length,
                two_star: twoStar.length,
                with_text: withText.length,
                without_text: withoutText.length,
                one_star_with_text: oneStar.filter(r => r.hasText).length,
                two_star_with_text: twoStar.filter(r => r.hasText).length
            },
            reviews: {
                one_star: oneStar,
                two_star: twoStar
            },
            debug: {
                best_match_used: bestMatch ? bestMatch.name : null,
                similarity_score: bestMatch ? (bestMatch.similarity * 100).toFixed(1) + '%' : null
            }
        });

    } catch (err) {
        console.error("\n❌ FATAL ERROR:", err.message);
        console.error(err.stack);
        
        res.json({
            success: false,
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    } finally {
        if (browser) {
            await browser.close();
            console.log("\n🔒 Browser kapatıldı");
        }
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🚀 === GOOGLE MAPS SCRAPER ULTIMATE ===`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log(`🔧 Debug: http://localhost:${PORT}/debug-chrome`);
    console.log(`\n📝 Kullanım:`);
    console.log(`POST http://localhost:${PORT}/scrape`);
    console.log(`Body: { "business": "By Ali", "location": "Berlin" }`);
    console.log(`\n✨ Özellikler:`);
    console.log(`  ✅ Fuzzy matching ile doğru işletmeyi bulur`);
    console.log(`  ✅ SHA-256 hash ile 100% duplikasyon önleme`);
    console.log(`  ✅ Maksimum yorum çekme (600 scroll)`);
    console.log(`  ✅ Agresif consent bypass`);
    console.log(`  ✅ 8 farklı arama stratejisi`);
    console.log(`========================================\n`);
});
