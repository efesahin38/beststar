/**
 * GOOGLE MAPS SCRAPER
 * Render Free Tier (512MB) Uyumlu
 * RAM Optimize + Duplicate Fix + Reliable Place Finder
 */

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- HEALTH ---------------- */
app.get("/health", (_, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

/* ---------------- SCRAPE ---------------- */
app.post("/scrape", async (req, res) => {
  const { business } = req.body;
  if (!business) return res.json({ error: "business gerekli" });

  let browser;
  try {
    /* --------- LAUNCH (RAM SAFE) --------- */
    browser = await puppeteer.launch({
      headless: "new",
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-first-run",
        "--single-process",
        "--no-zygote"
      ]
    });

    const page = await browser.newPage();

    /* --------- REQUEST BLOCK (RAM ↓↓↓) --------- */
    await page.setRequestInterception(true);
    page.on("request", req => {
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) req.abort();
      else req.continue();
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultTimeout(180000);

    /* --------- STEALTH --------- */
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    /* --------- MAPS SEARCH --------- */
    const searchUrl =
      "https://www.google.com/maps/search/" +
      encodeURIComponent(business);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await delay(8000);

    /* --------- PLACE OPEN (GUARANTEED) --------- */
    let placeOpened = false;

    // 1️⃣ Direkt place link
    const directPlace = await page.$('a[href*="/maps/place/"]');
    if (directPlace) {
      await directPlace.click();
      placeOpened = true;
      await delay(6000);
    }

    // 2️⃣ Article cards
    if (!placeOpened) {
      const cards = await page.$$('div[role="article"]');
      if (cards.length) {
        await cards[0].click();
        placeOpened = true;
        await delay(6000);
      }
    }

    // 3️⃣ Fallback click
    if (!placeOpened) {
      await page.mouse.click(400, 400);
      await delay(5000);
    }

    if (!page.url().includes("/maps/place/")) {
      throw new Error("İşletme kartı açılamadı");
    }

    /* --------- BUSINESS INFO --------- */
    const businessInfo = await page.evaluate(() => {
      const name =
        document.querySelector("h1")?.innerText || "Bulunamadı";

      let address = "Bulunamadı";
      document.querySelectorAll("button, div").forEach(el => {
        const a = el.getAttribute("aria-label") || "";
        if (a.toLowerCase().includes("adres"))
          address = el.innerText.replace(/\n/g, " ");
      });

      return { name, address };
    });

    /* --------- OPEN REVIEWS --------- */
    await delay(3000);
    const reviewBtn =
      (await page.$('button[jsaction*="moreReviews"]')) ||
      (await page.$('button[aria-label*="yorum" i]')) ||
      (await page.$('button[aria-label*="review" i]'));

    if (reviewBtn) {
      await reviewBtn.click();
      await delay(5000);
    }

    /* --------- SCROLL (SMART STOP) --------- */
    let lastCount = 0;
    let stable = 0;

    for (let i = 0; i < 200; i++) {
      const count = await page.evaluate(() => {
        const items = document.querySelectorAll(
          '[data-review-id], div[role="article"]'
        );
        const box =
          document.querySelector(".m6QErb") ||
          document.querySelector('[role="main"]');
        if (box) box.scrollTop = box.scrollHeight;
        return items.length;
      });

      if (count === lastCount) stable++;
      else stable = 0;

      lastCount = count;
      if (stable > 6) break;
      await delay(1000);
    }

    /* --------- PARSE REVIEWS (NO DUPLICATE) --------- */
    const reviews = await page.evaluate(() => {
      const uniq = new Set();
      const data = [];

      document
        .querySelectorAll('[data-review-id], div[role="article"]')
        .forEach(card => {
          const starEl = card.querySelector('[role="img"]');
          const txtEl = card.querySelector(".wiI7pd");

          if (!starEl) return;
          const match = starEl
            .getAttribute("aria-label")
            ?.match(/(\d+)/);
          if (!match) return;

          const rating = parseInt(match[1]);
          if (rating > 2) return;

          const text = txtEl?.innerText?.trim() || "";
          const key =
            card.getAttribute("data-review-id") ||
            btoa(text.slice(0, 80));

          if (uniq.has(key)) return;
          uniq.add(key);

          data.push({
            rating,
            text,
            hasText: text.length > 0
          });
        });

      return data;
    });

    const one = reviews.filter(r => r.rating === 1);
    const two = reviews.filter(r => r.rating === 2);

    res.json({
      success: true,
      name: businessInfo.name,
      address: businessInfo.address,
      "1_star": one.length,
      "2_star": two.length,
      reviews_1_star: one,
      reviews_2_star: two
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ---------------- SERVER ---------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log("🚀 Server running on port", PORT)
);
