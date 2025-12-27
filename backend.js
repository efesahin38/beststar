// GOOGLE MAPS SCRAPER - ULTRA GÜVENİLİR VERSİYON
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

// Yorum için benzersiz hash oluştur
const createReviewHash = (review) => {
    const data = `${review.author}|${review.rating}|${review.text.substring(0, 100)}`;
    return crypto.createHash('md5').update(data).digest('hex');
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
                "--window-size=1920,1080",
                "--single-process",
                "--no-zygote",
                "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultTimeout(300000);
        await page.setViewport({ width: 1920, height: 1080 });

        // Anti-bot bypass
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
            window.chrome = { runtime: {} };
        });

        await page.setCookie({
            name: 'CONSENT',
            value: 'YES+cb.20210720-07-p0.tr+FX+410',
            domain: '.google.com',
            path: '/',
            expires: Date.now() / 1000 + 31536000
        });

        // ============================================
        // 1. GOOGLE MAPS SEARCH
        // ============================================
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(business)}`;
        console.log("🌐 Google Maps açılıyor...");
        
        await page.goto(searchUrl, { 
            waitUntil: "networkidle2", 
            timeout: 180000 
        });
        
        await delay(10000); // İlk yükleme

        // ============================================
        // 2. COOKIE CONSENT BYPASS
        // ============================================
        console.log("🍪 Cookie kontrolü...");
        let retryCount = 0;
        const MAX_RETRY = 3;

        while (page.url().includes('consent.google.com') && retryCount < MAX_RETRY) {
            console.log(`⚠️ Consent sayfası (deneme ${retryCount + 1}/${MAX_RETRY})...`);
            
            // Tüm consent bypass yöntemlerini dene
            await page.evaluate(() => {
                // Yöntem 1: Buton click
                const buttons = Array.from(document.querySelectorAll('button'));
                const acceptBtn = buttons.find(b => 
                    b.textContent.toLowerCase().includes('accept') ||
                    b.textContent.toLowerCase().includes('kabul') ||
                    b.textContent.toLowerCase().includes('akzeptieren') ||
                    b.textContent.toLowerCase().includes('все')
                );
                if (acceptBtn) acceptBtn.click();

                // Yöntem 2: Form submit
                setTimeout(() => {
                    const form = document.querySelector('form');
                    if (form) form.submit();
                }, 1000);
            });
            
            await delay(8000);
            retryCount++;
        }

        // Hala consent'te ise direkt Maps'e git
        if (page.url().includes('consent.google.com')) {
            console.log("🔄 Direkt Maps navigasyonu...");
            await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 180000 });
            await delay(12000);
        }

        console.log("✅ Maps sayfasında");

        // ============================================
        // 3. İŞLETME KARTINI BUL - GELİŞMİŞ ARAMA
        // ============================================
        console.log("🎯 İşletme kartı aranıyor...");
        let placeFound = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 5;

        while (!placeFound && attempts < MAX_ATTEMPTS) {
            attempts++;
            console.log(`🔍 Arama denemesi ${attempts}/${MAX_ATTEMPTS}`);

            // Sayfa yapısını analiz et
            const pageInfo = await page.evaluate(() => {
                return {
                    placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
                    cards: document.querySelectorAll('.hfpxzc, div[role="article"], .Nv2PK').length,
                    url: window.location.href,
                    hasResults: document.body.innerText.includes('sonuç') || 
                               document.body.innerText.includes('results') ||
                               document.querySelectorAll('a[href*="/maps/place/"]').length > 0
                };
            });

            console.log(`📊 Place links: ${pageInfo.placeLinks}, Cards: ${pageInfo.cards}`);

            // Sonuç yoksa
            if (!pageInfo.hasResults) {
                console.log("⚠️ Hiç sonuç bulunamadı, sayfa yenileniyor...");
                await page.reload({ waitUntil: "networkidle2" });
                await delay(10000);
                continue;
            }

            // YÖNTEM 1: Place link'e tıkla (EN GÜÇLÜ)
            if (!placeFound) {
                try {
                    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 });
                    const placeLinks = await page.$$('a[href*="/maps/place/"]');
                    
                    if (placeLinks.length > 0) {
                        const firstLink = placeLinks[0];
                        const linkInfo = await page.evaluate(el => ({
                            text: el.textContent?.trim(),
                            href: el.href
                        }), firstLink);
                        
                        console.log(`✅ İşletme bulundu: ${linkInfo.text}`);
                        console.log(`🔗 URL: ${linkInfo.href.substring(0, 80)}...`);
                        
                        // Tıklama ve navigation
                        await Promise.all([
                            page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
                            firstLink.click()
                        ]);
                        
                        placeFound = true;
                        await delay(8000);
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 1 hata:", e.message);
                }
            }

            // YÖNTEM 2: Kart selectors
            if (!placeFound) {
                const cardSelectors = ['.hfpxzc', '.Nv2PK', 'div[role="article"]', 'a.hfpxzc'];
                
                for (const selector of cardSelectors) {
                    try {
                        const cards = await page.$$(selector);
                        if (cards.length > 0) {
                            console.log(`✅ ${selector} kartı bulundu, tıklanıyor...`);
                            await cards[0].click();
                            await delay(8000);
                            
                            if (page.url().includes('/maps/place/')) {
                                placeFound = true;
                                break;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            // YÖNTEM 3: Direkt URL navigation
            if (!placeFound) {
                try {
                    const placeUrl = await page.evaluate(() => {
                        const link = document.querySelector('a[href*="/maps/place/"]');
                        return link ? link.href : null;
                    });
                    
                    if (placeUrl) {
                        console.log(`🔗 Direkt URL'ye gidiliyor...`);
                        await page.goto(placeUrl, { waitUntil: "networkidle2", timeout: 60000 });
                        placeFound = true;
                        await delay(10000);
                    }
                } catch (e) {
                    console.log("⚠️ Yöntem 3 hata:", e.message);
                }
            }

            if (!placeFound) {
                console.log("⏳ Sayfa biraz daha bekleniyor...");
                await delay(5000);
            }
        }

        if (!placeFound) {
            console.log("❌ İşletme kartı bulunamadı!");
            try {
                const fs = require('fs');
                await page.screenshot({ path: '/tmp/debug_no_place.png', fullPage: true });
                const html = await page.content();
                fs.writeFileSync('/tmp/debug_page.html', html);
            } catch (err) {}
            
            return res.json({ 
                error: "İşletme bulunamadı. Lütfen işletme adını kontrol edin.",
                debug: "Screenshot ve HTML /tmp/ klasörüne kaydedildi"
            });
        }

        console.log("🎉 İşletme kartı başarıyla açıldı!");

        // ============================================
        // 4. İŞLETME BİLGİLERİNİ AL
        // ============================================
        console.log("📋 İşletme bilgileri alınıyor...");
        await page.waitForSelector('h1.DUwDvf, h1', { timeout: 30000 });
        await delay(3000);

        const businessInfo = await page.evaluate(() => {
            const name = document.querySelector('h1.DUwDvf')?.innerText?.trim() || 
                         document.querySelector('h1')?.innerText?.trim() || 
                         'Bilinmiyor';
            
            let address = 'Adres bulunamadı';
            const addressSelectors = [
                'button[data-item-id="address"]',
                'button[data-tooltip*="Adresi"]',
                'button[aria-label*="Address"]',
                'button[aria-label*="Adres"]'
            ];

            for (const selector of addressSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const text = el.innerText?.replace(/\n/g, ' ').trim();
                    if (text && text.length > 10) {
                        address = text;
                        break;
                    }
                }
            }

            return { name, address };
        });

        console.log("🏢 İşletme:", businessInfo.name);
        console.log("📍 Adres:", businessInfo.address);

        // ============================================
        // 5. YORUMLAR SEKMESİNİ AÇ
        // ============================================
        console.log("💬 Yorumlar sekmesi açılıyor...");
        await delay(3000);
        
        let reviewsOpened = false;
        const reviewButtonSelectors = [
            'button[jsaction*="pane.rating.moreReviews"]',
            'button[aria-label*="review" i]',
            'button[aria-label*="yorum" i]',
            'button.hh2c6',
            'div.AeaXub button',
            'button[data-tab-index="1"]',
            'button.fontTitleSmall'
        ];

        for (const selector of reviewButtonSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn) {
                    const btnText = await page.evaluate(el => el.textContent, btn);
                    console.log(`🎯 Yorum butonu: "${btnText}" (${selector})`);
                    
                    await btn.click();
                    await delay(8000);
                    reviewsOpened = true;
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!reviewsOpened) {
            console.log("⚠️ Yorum butonu bulunamadı, devam ediliyor...");
        } else {
            console.log("✅ Yorumlar sekmesi açıldı");
        }

        // ============================================
        // 6. SIRALAMA - EN DÜŞÜK PUANLI
        // ============================================
        console.log("⭐ Sıralama: En düşük puanlı...");
        await delay(3000);

        try {
            const sortSelectors = [
                'button[aria-label*="sırala" i]',
                'button[aria-label*="sort" i]',
                'button[data-value="Sort"]'
            ];

            let sortBtn = null;
            for (const selector of sortSelectors) {
                sortBtn = await page.$(selector);
                if (sortBtn) break;
            }

            if (sortBtn) {
                await sortBtn.click();
                console.log("✅ Sıralama menüsü açıldı");
                await delay(2000);

                // En düşük puanlı seç
                const lowestOption = await page.evaluate(() => {
                    const options = Array.from(document.querySelectorAll('div[role="menuitemradio"]'));
                    const lowestOpt = options.find(opt => 
                        opt.textContent.toLowerCase().includes('düşük') ||
                        opt.textContent.toLowerCase().includes('lowest') ||
                        opt.textContent.toLowerCase().includes('niedrigste')
                    );
                    
                    if (lowestOpt) {
                        lowestOpt.click();
                        return true;
                    }
                    
                    // Alternatif: 2. seçenek
                    if (options[1]) {
                        options[1].click();
                        return true;
                    }
                    
                    return false;
                });

                if (lowestOption) {
                    console.log("✅ En düşük puanlı seçildi");
                    await delay(5000);
                } else {
                    console.log("⚠️ Sıralama seçeneği bulunamadı");
                }
            }
        } catch (e) {
            console.log("⚠️ Sıralama yapılamadı:", e.message);
        }

        // ============================================
        // 7. SCROLL - ADAPTIVE & SMART
        // ============================================
        console.log("📜 Scroll başlatılıyor (akıllı mod)...");

        let lastReviewCount = 0;
        let noChangeCount = 0;
        const NO_CHANGE_LIMIT = 10; // 10 kez değişmezse dur
        const MAX_SCROLL = 500;
        let totalScrolled = 0;

        for (let i = 0; i < MAX_SCROLL; i++) {
            const scrollInfo = await page.evaluate(() => {
                // Yorum container'ı bul (çoklu strateji)
                const containerSelectors = [
                    '.m6QErb.DxyBCb.kA9KIf.dS8AEf',
                    '.m6QErb',
                    'div[role="region"]',
                    'div[tabindex="-1"]',
                    '[role="main"]'
                ];

                let container = null;
                for (const sel of containerSelectors) {
                    container = document.querySelector(sel);
                    if (container && container.scrollHeight > container.clientHeight) {
                        break;
                    }
                }

                if (!container) {
                    return { success: false, reviews: 0 };
                }

                // Scroll yap
                const beforeScroll = container.scrollTop;
                container.scrollTop = container.scrollHeight;
                const afterScroll = container.scrollTop;
                const scrolledAmount = afterScroll - beforeScroll;

                // Yorum sayısını say (çoklu selector)
                const reviewCount = Math.max(
                    document.querySelectorAll('[data-review-id]').length,
                    document.querySelectorAll('.jftiEf').length,
                    document.querySelectorAll('.wiI7pd').length,
                    document.querySelectorAll('div[role="article"]').length
                );

                return { 
                    success: true, 
                    reviews: reviewCount,
                    scrolledAmount,
                    atBottom: scrolledAmount < 50
                };
            });

            await randomDelay(1000, 1500); // İnsan gibi scroll

            if (!scrollInfo.success) {
                console.log("⚠️ Scroll container bulunamadı");
                break;
            }

            totalScrolled += scrollInfo.scrolledAmount || 0;

            // Değişim kontrolü
            if (scrollInfo.reviews === lastReviewCount) {
                noChangeCount++;
            } else {
                noChangeCount = 0;
                lastReviewCount = scrollInfo.reviews;
            }

            // Loglama
            if (i % 20 === 0) {
                console.log(`📊 Scroll ${i} | Yorum: ${scrollInfo.reviews} | Sabit: ${noChangeCount} | Toplam scroll: ${totalScrolled}px`);
            }

            // Durma koşulları
            if (noChangeCount >= NO_CHANGE_LIMIT && i > 20) {
                console.log("🛑 Yorum sayısı artmıyor, scroll durduruluyor");
                break;
            }

            if (scrollInfo.atBottom && noChangeCount > 3) {
                console.log("🛑 Sayfa sonuna ulaşıldı");
                break;
            }
        }

        console.log(`✅ Scroll tamamlandı | Son yorum: ${lastReviewCount}`);
        await delay(5000); // Son yorumların yüklenmesi için

        // ============================================
        // 8. YORUMLARI ÇEK - GELİŞMİŞ PARSE + HASH
        // ============================================
        console.log("🔍 Yorumlar parse ediliyor (duplikasyon önleme aktif)...");

        const reviews = await page.evaluate(() => {
            const results = [];
            const seenHashes = new Set();

            // Yorum kartlarını bul (çoklu selector)
            const reviewSelectors = [
                'div[role="article"]',
                '[data-review-id]',
                '.jftiEf',
                '.MyEned'
            ];

            let reviewElements = [];
            for (const selector of reviewSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    reviewElements = Array.from(elements);
                    console.log(`✅ ${selector}: ${elements.length} kart`);
                    break;
                }
            }

            if (reviewElements.length === 0) {
                console.log("❌ Hiç yorum kartı bulunamadı!");
                return [];
            }

            // "Daha fazla" butonlarına tıkla
            console.log("📖 Yorumlar genişletiliyor...");
            reviewElements.forEach(card => {
                const expandBtns = card.querySelectorAll('button[aria-label*="daha" i], button[aria-label*="more" i], button.w8nwRe');
                expandBtns.forEach(btn => {
                    if (btn && btn.offsetHeight > 0) {
                        try { btn.click(); } catch (e) {}
                    }
                });
            });

            // Parse işlemi
            console.log("🔍 Parse başlıyor...");
            reviewElements.forEach((card, index) => {
                try {
                    // Yıldız puanı
                    let rating = null;
                    const starEl = card.querySelector('[role="img"][aria-label*="star" i], [role="img"][aria-label*="yıldız" i]');
                    if (starEl) {
                        const ariaLabel = starEl.getAttribute('aria-label') || '';
                        const match = ariaLabel.match(/(\d+)/);
                        if (match) rating = parseInt(match[1]);
                    }

                    // Sadece 1-2 yıldız
                    if (!rating || rating > 2) return;

                    // Yazar adı
                    let author = 'Anonim';
                    const authorEl = card.querySelector('.d4r55, .WEBjve');
                    if (authorEl) {
                        author = authorEl.textContent?.trim().split('·')[0].split('\n')[0].trim() || 'Anonim';
                    }

                    // Yorum metni
                    let text = '';
                    const textSelectors = ['.wiI7pd', 'span[data-expandable-section]', '.MyEned', '.rsqaWe'];
                    for (const selector of textSelectors) {
                        const textEl = card.querySelector(selector);
                        if (textEl && textEl.textContent.trim()) {
                            text = textEl.textContent.trim();
                            break;
                        }
                    }

                    // Tarih (opsiyonel)
                    let date = '';
                    const dateEl = card.querySelector('.rsqaWe, .DU9Pgb');
                    if (dateEl) {
                        date = dateEl.textContent?.trim() || '';
                    }

                    // HASH OLUŞTUR (duplikasyon önleme)
                    const hashData = `${author}_${rating}_${text.substring(0, 100)}_${date}`;
                    const hash = hashData.split('').reduce((a, b) => {
                        a = ((a << 5) - a) + b.charCodeAt(0);
                        return a & a;
                    }, 0);

                    // Duplikasyon kontrolü
                    if (seenHashes.has(hash)) {
                        console.log(`⚠️ Duplike bulundu: ${author} - ${rating}⭐`);
                        return;
                    }

                    seenHashes.add(hash);

                    results.push({
                        rating,
                        text,
                        author,
                        date,
                        hasReview: text.length > 0,
                        hash
                    });

                } catch (e) {
                    console.error(`❌ Parse hatası ${index}:`, e.message);
                }
            });

            console.log(`✅ Parse tamamlandı: ${results.length} benzersiz yorum`);
            return results;
        });

        console.log(`✅ Toplam ${reviews.length} benzersiz 1-2 yıldızlı yorum çekildi`);

        // İstatistikler
        const oneStar = reviews.filter(r => r.rating === 1);
        const twoStar = reviews.filter(r => r.rating === 2);
        const withText = reviews.filter(r => r.hasReview);
        const withoutText = reviews.filter(r => !r.hasReview);

        console.log(`⭐ 1 yıldız: ${oneStar.length}`);
        console.log(`⭐ 2 yıldız: ${twoStar.length}`);
        console.log(`📝 Metin ile: ${withText.length}`);
        console.log(`📭 Metin yok: ${withoutText.length}`);

        // ============================================
        // 9. SONUÇ DÖNDÜR
        // ============================================
        res.json({
            success: true,
            business_name: businessInfo.name,
            address: businessInfo.address,
            statistics: {
                total: reviews.length,
                one_star: oneStar.length,
                two_star: twoStar.length,
                with_text: withText.length,
                without_text: withoutText.length
            },
            reviews: {
                one_star: oneStar,
                two_star: twoStar
            },
            metadata: {
                scraped_at: new Date().toISOString(),
                scraper_version: "2.0-ultra-reliable"
            }
        });

    } catch (err) {
        console.error("❌ FATAL ERROR:", err.message);
        console.error(err.stack);
        res.json({
            success: false,
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
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
    console.log(`💡 Health: http://localhost:${PORT}/health`);
    console.log(`💡 Debug: http://localhost:${PORT}/debug-chrome`);
    console.log(`📋 Scraper: POST http://localhost:${PORT}/scrape`);
});
