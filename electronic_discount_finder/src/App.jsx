import React, { useEffect, useState } from "react";
import axios from "axios";
import Papa from "papaparse";
import "./App.css";

/** -------------------- CONFIG -------------------- */
const LIST_FIELDS = {
  credit: ["Eligible Credit Cards", "Eligible Cards"],
  debit: ["Eligible Debit Cards", "Applicable Debit Cards"],
  title: ["Offer Title", "Title"],
  image: ["Image", "Credit Card Image", "Offer Image"],
  link: ["Link", "Offer Link"],
  desc: ["Description", "Details", "Offer Description", "Flight Benefit"],
};

const MAX_SUGGESTIONS = 50;

/** -------------------- HELPERS -------------------- */
const toNorm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function firstField(obj, keys) {
  for (const k of keys) {
    if (
      obj &&
      Object.prototype.hasOwnProperty.call(obj, k) &&
      obj[k] !== undefined &&
      obj[k] !== null &&
      String(obj[k]).trim() !== ""
    ) {
      return obj[k];
    }
  }
  return undefined;
}

function splitList(val) {
  if (!val) return [];
  return String(val)
    .replace(/\n/g, " ")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip trailing parentheses: "HDFC Regalia (Visa Signature)" -> "HDFC Regalia" */
function getBase(name) {
  if (!name) return "";
  return String(name).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** ➕ NEW: Extract variant from trailing parentheses: "… (Rupay Classic)" -> "Rupay Classic" */
function getVariant(name) {
  if (!name) return "";
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}

/** Canonicalize some common brand spellings */
function brandCanonicalize(text) {
  let s = String(text || "");
  s = s.replace(/\bMakemytrip\b/gi, "MakeMyTrip");
  s = s.replace(/\bIcici\b/gi, "ICICI");
  s = s.replace(/\bHdfc\b/gi, "HDFC");
  s = s.replace(/\bSbi\b/gi, "SBI");
  s = s.replace(/\bIdfc\b/gi, "IDFC");
  s = s.replace(/\bPnb\b/gi, "PNB");
  s = s.replace(/\bRbl\b/gi, "RBL");
  s = s.replace(/\bYes\b/gi, "YES");
  return s;
}

/** Levenshtein distance */
function lev(a, b) {
  a = toNorm(a);
  b = toNorm(b);
  const n = a.length,
    m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }
  return d[n][m];
}

function scoreCandidate(q, cand) {
  const qs = toNorm(q);
  const cs = toNorm(cand);
  if (!qs) return 0;
  if (cs.includes(qs)) return 100;

  const qWords = qs.split(" ").filter(Boolean);
  const cWords = cs.split(" ").filter(Boolean);

  const matchingWords = qWords.filter((qw) =>
    cWords.some((cw) => cw.includes(qw))
  ).length;
  const sim = 1 - lev(qs, cs) / Math.max(qs.length, cs.length);
  return (matchingWords / Math.max(1, qWords.length)) * 0.7 + sim * 0.3;
}

/** Dropdown entry builder */
function makeEntry(raw, type) {
  const base = brandCanonicalize(getBase(raw));
  return { type, display: base, baseNorm: toNorm(base) };
}

/** Dedup helpers */
function normalizeText(s) {
  return toNorm(s || "");
}
function normalizeUrl(u) {
  if (!u) return "";
  let s = String(u).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
function offerKey(o) {
  const title = normalizeText(firstField(o, LIST_FIELDS.title) || "");
  const desc = normalizeText(firstField(o, LIST_FIELDS.desc) || "");
  const link = normalizeUrl(firstField(o, LIST_FIELDS.link) || "");
  const img = normalizeUrl(firstField(o, LIST_FIELDS.image) || "");
  return `${title}||${desc}||${link}||${img}`;
}
function dedupWrappers(arr, seen) {
  const out = [];
  for (const w of arr || []) {
    const k = offerKey(w.offer);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/** Disclaimer */
const Disclaimer = () => (
  <section className="disclaimer">
    <h3>Disclaimer</h3>
    <p>
      All offers, coupons, and discounts listed on our platform are provided for
      informational purposes only. We do not guarantee the accuracy,
      availability, or validity of any offer. Users are advised to verify the
      terms and conditions with the respective merchants before making any
      purchase. We are not responsible for any discrepancies, expired offers, or
      losses arising from the use of these coupons.
    </p>
  </section>
);

/** -------------------- COMPONENT -------------------- */
const HotelOffers = () => {
  // dropdown data
  const [creditEntries, setCreditEntries] = useState([]);
  const [debitEntries, setDebitEntries] = useState([]);

  // marquee (built from all offer CSVs)
  const [marqueeCC, setMarqueeCC] = useState([]);
  const [marqueeDC, setMarqueeDC] = useState([]);

  // ui state
  const [filteredCards, setFilteredCards] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null); // {type, display, baseNorm}
  const [noMatches, setNoMatches] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // offers
  const [amazonOffers, setAmazonOffers] = useState([]);
  const [cromaOffers, setCromaOffers] = useState([]);
  const [flipkartOffers, setFlipkartOffers] = useState([]);
  const [relianceOffers, setRelianceOffers] = useState([]);
  const [instamartOffers, setInstamartOffers] = useState([]);
  const [blinkingOffers, setBlinkingOffers] = useState([]);

  // responsive
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 1) Load allCards.csv
  useEffect(() => {
    async function loadAllCards() {
      try {
        const res = await axios.get(`/allCards.csv`);
        const parsed = Papa.parse(res.data, { header: true });
        const rows = parsed.data || [];

        const creditMap = new Map();
        const debitMap = new Map();

        for (const row of rows) {
          const ccList = splitList(firstField(row, LIST_FIELDS.credit));
          for (const raw of ccList) {
            const base = brandCanonicalize(getBase(raw));
            const baseNorm = toNorm(base);
            if (baseNorm) creditMap.set(baseNorm, creditMap.get(baseNorm) || base);
          }
          const dcList = splitList(firstField(row, LIST_FIELDS.debit));
          for (const raw of dcList) {
            const base = brandCanonicalize(getBase(raw));
            const baseNorm = toNorm(base);
            if (baseNorm) debitMap.set(baseNorm, debitMap.get(baseNorm) || base);
          }
        }

        const credit = Array.from(creditMap.values())
          .sort((a, b) => a.localeCompare(b))
          .map((d) => makeEntry(d, "credit"));
        const debit = Array.from(debitMap.values())
          .sort((a, b) => a.localeCompare(b))
          .map((d) => makeEntry(d, "debit"));

        setCreditEntries(credit);
        setDebitEntries(debit);
      } catch (e) {
        console.error("allCards.csv load error:", e);
      }
    }
    loadAllCards();
  }, []);

  // 2) Load offer CSVs
  useEffect(() => {
    async function loadOffers() {
      try {
        const files = [
          { name: "amazon.csv", setter: setAmazonOffers },
          { name: "croma.csv", setter: setCromaOffers },
          { name: "flipkart.csv", setter: setFlipkartOffers },
          { name: "reliance-digital.csv", setter: setRelianceOffers },
          { name: "instamart.csv", setter: setInstamartOffers },
          { name: "blinking.csv", setter: setBlinkingOffers },
        ];

        await Promise.all(
          files.map(async (f) => {
            const res = await axios.get(`/${encodeURIComponent(f.name)}`);
            const parsed = Papa.parse(res.data, { header: true });
            f.setter(parsed.data || []);
          })
        );
      } catch (e) {
        console.error("Offer CSV load error:", e);
      }
    }
    loadOffers();
  }, []);

  /** Build marquee CC/DC from all OFFER CSVs (skip "All CC/DC") */
  useEffect(() => {
    const ccMap = new Map();
    const dcMap = new Map();

    const harvest = (rows) => {
      for (const o of rows || []) {
        const cc = splitList(firstField(o, LIST_FIELDS.credit));
        const dc = splitList(firstField(o, LIST_FIELDS.debit));

        for (const raw of cc) {
          if (toNorm(raw) === "all cc") continue;
          const base = brandCanonicalize(getBase(raw));
          const baseNorm = toNorm(base);
          if (baseNorm) ccMap.set(baseNorm, ccMap.get(baseNorm) || base);
        }
        for (const raw of dc) {
          if (toNorm(raw) === "all dc") continue;
          const base = brandCanonicalize(getBase(raw));
          const baseNorm = toNorm(base);
          if (baseNorm) dcMap.set(baseNorm, dcMap.get(baseNorm) || base);
        }

        const mixed = splitList(o["Eligible Cards"]);
        for (const raw of mixed) {
          const lower = raw.toLowerCase();
          const base = brandCanonicalize(getBase(raw));
          const baseNorm = toNorm(base);
          if (!baseNorm) continue;
          if (lower.includes("debit")) dcMap.set(baseNorm, dcMap.get(baseNorm) || base);
          else if (lower.includes("credit"))
            ccMap.set(baseNorm, ccMap.get(baseNorm) || base);
        }
      }
    };

    harvest(amazonOffers);
    harvest(cromaOffers);
    harvest(flipkartOffers);
    harvest(relianceOffers);
    harvest(instamartOffers);
    harvest(blinkingOffers);

    setMarqueeCC(Array.from(ccMap.values()).sort((a, b) => a.localeCompare(b)));
    setMarqueeDC(Array.from(dcMap.values()).sort((a, b) => a.localeCompare(b)));
  }, [
    amazonOffers,
    cromaOffers,
    flipkartOffers,
    relianceOffers,
    instamartOffers,
    blinkingOffers,
  ]);

  /** 🔎 search box — debit-first when query hints debit */
  const onChangeQuery = (e) => {
    const val = e.target.value;
    setQuery(val);

    if (!val.trim()) {
      setFilteredCards([]);
      setSelected(null);
      setNoMatches(false);
      return;
    }

    const q = val.trim().toLowerCase();
    const debitHint =
      q.includes("debit cards") ||
      q.includes("debit card") ||
      q.includes("debit") ||
      q.includes("dc");

    const scored = (arr) =>
      arr
        .map((it) => {
          const s = scoreCandidate(val, it.display);
          const inc = it.display.toLowerCase().includes(q);
          return { it, s, inc };
        })
        .filter(({ s, inc }) => inc || s > 0.3)
        .sort((a, b) => b.s - a.s || a.it.display.localeCompare(b.it.display))
        .slice(0, MAX_SUGGESTIONS)
        .map(({ it }) => it);

    const cc = scored(creditEntries);
    const dc = scored(debitEntries);

    if (!cc.length && !dc.length) {
      setNoMatches(true);
      setSelected(null);
      setFilteredCards([]);
      return;
    }

    const firstList = debitHint ? dc : cc;
    const firstLabel = debitHint ? "Debit Cards" : "Credit Cards";
    const secondList = debitHint ? cc : dc;
    const secondLabel = debitHint ? "Credit Cards" : "Debit Cards";

    setNoMatches(false);
    setFilteredCards([
      ...(firstList.length ? [{ type: "heading", label: firstLabel }] : []),
      ...firstList,
      ...(secondList.length ? [{ type: "heading", label: secondLabel }] : []),
      ...secondList,
    ]);
  };

  const onPick = (entry) => {
    setSelected(entry);
    setQuery(entry.display);
    setFilteredCards([]);
    setNoMatches(false);
  };

  // Click a marquee chip → set the dropdown + selected entry
  const handleChipClick = (name, type) => {
    const display = brandCanonicalize(getBase(name));
    const baseNorm = toNorm(display);
    setQuery(display);
    setSelected({ type, display, baseNorm });
    setFilteredCards([]);
    setNoMatches(false);
  };

  /** ➕ UPDATED: return wrappers {offer, site, variantText} and honor "All CC/DC" */
  function matchesFor(offers, site, type) {
    if (!selected) return [];
    const out = [];

    for (const o of offers || []) {
      let list = [];

      if (type === "credit") {
        list = splitList(firstField(o, LIST_FIELDS.credit));
        if (list.some((v) => toNorm(v) === "all cc")) {
          if (selected.type === "credit") out.push({ offer: o, site, variantText: "" });
          continue;
        }
      } else if (type === "debit") {
        list = splitList(firstField(o, LIST_FIELDS.debit));
        if (list.some((v) => toNorm(v) === "all dc")) {
          if (selected.type === "debit") out.push({ offer: o, site, variantText: "" });
          continue;
        }
      }

      for (const raw of list) {
        const base = brandCanonicalize(getBase(raw));
        if (toNorm(base) === selected.baseNorm) {
          const v = getVariant(raw); // capture the variant text, if any
          out.push({ offer: o, site, variantText: v || "" });
          break;
        }
      }
    }
    return out;
  }

  // Collect raw
  const wAmazon = matchesFor(amazonOffers, "Amazon", selected?.type);
  const wCroma = matchesFor(cromaOffers, "Croma", selected?.type);
  const wFlipkart = matchesFor(flipkartOffers, "Flipkart", selected?.type);
  const wReliance = matchesFor(relianceOffers, "Reliance Digital", selected?.type);
  const wInstamart = matchesFor(instamartOffers, "Instamart", selected?.type);
  const wBlinking = matchesFor(blinkingOffers, "Blinking", selected?.type);

  // Dedup across all
  const seen = new Set();
  const dAmazon = dedupWrappers(wAmazon, seen);
  const dCroma = dedupWrappers(wCroma, seen);
  const dFlipkart = dedupWrappers(wFlipkart, seen);
  const dReliance = dedupWrappers(wReliance, seen);
  const dInstamart = dedupWrappers(wInstamart, seen);
  const dBlinking = dedupWrappers(wBlinking, seen);

  const hasAny = Boolean(
    dAmazon.length ||
      dCroma.length ||
      dFlipkart.length ||
      dReliance.length ||
      dInstamart.length ||
      dBlinking.length
  );

  /** Offer card UI */
  const OfferCard = ({ wrapper }) => {
    const o = wrapper.offer;

    // case-insensitive exact-key getter
    const getCI = (obj, key) => {
      if (!obj) return undefined;
      const target = String(key).toLowerCase();
      for (const k of Object.keys(obj)) {
        if (String(k).toLowerCase() === target) return obj[k];
      }
      return undefined;
    };

    // Defaults
    const titleDefault =
      firstField(o, ["Offer Title"]) || firstField(o, LIST_FIELDS.title) || "Offer";
    const descDefault = firstField(o, LIST_FIELDS.desc);
    const linkDefault = firstField(o, LIST_FIELDS.link);
    const imageDefault = firstField(o, LIST_FIELDS.image);

    const site = String(wrapper.site || "");

    // Amazon: Offer + scrollable T&C
    if (site === "Amazon") {
      const title = getCI(o, "Offer Title") || titleDefault;
      const terms =
        getCI(o, "Terms and Conditions") ||
        getCI(o, "Terms & Conditions") ||
        getCI(o, "T&C") ||
        "";

      return (
        <div className="offer-card">
          <div className="offer-info">
            <h3 className="offer-title">{title}</h3>
            {terms && (
              <div
                style={{
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid #ccc",
                  padding: "8px",
                }}
              >
                <strong>Terms &amp; Conditions:</strong>
                <br />
                {terms}
              </div>
            )}

            {/* ➕ NEW: Variant note if present */}
            {wrapper.variantText && (
              <p className="network-note">
                <strong>Note:</strong> This benefit is applicable only on{" "}
                <em>{wrapper.variantText}</em> variant
              </p>
            )}
          </div>
        </div>
      );
    }

    // Croma: Image + Offer + scrollable T&C + View Offer
    if (site === "Croma") {
      const title = getCI(o, "Offer Title") || titleDefault;
      const terms =
        getCI(o, "Terms and Conditions") ||
        getCI(o, "Terms & Conditions") ||
        getCI(o, "T&C") ||
        "";
      const link = getCI(o, "Link") || linkDefault;
      const img = getCI(o, "Image") || imageDefault;

      return (
        <div className="offer-card">
          {img && <img src={img} alt="Offer" />}
          <div className="offer-info">
            <h3 className="offer-title">{title}</h3>
            {terms && (
              <div
                style={{
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid #ccc",
                  padding: "8px",
                }}
              >
                <strong>Terms &amp; Conditions:</strong>
                <br />
                {terms}
              </div>
            )}
            {link && (
              <button className="btn" onClick={() => window.open(link, "_blank")}>
                View Offer
              </button>
            )}

            {/* ➕ NEW: Variant note */}
            {wrapper.variantText && (
              <p className="network-note">
                <strong>Note:</strong> This benefit is applicable only on{" "}
                <em>{wrapper.variantText}</em> variant
              </p>
            )}
          </div>
        </div>
      );
    }

    // Instamart / Blinking: Coupon (with Copy popup) + Offer + Description
    if (site === "Instamart" || site === "Blinking") {
      const title = getCI(o, "Offer Title") || titleDefault;
      const coupon = getCI(o, "Coupon Code");
      const desc = getCI(o, "Description") || descDefault;

      const onCopy = () => {
        if (!coupon) return;
        const text = String(coupon);
        const done = () => alert("Coupon code is copied!!"); // ➕ NEW POPUP

        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => {
            // Fallback
            try {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              done();
            } catch {}
          });
        } else {
          try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            done();
          } catch {}
        }
      };

      return (
        <div className="offer-card">
          <div className="offer-info">
            {coupon && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    padding: "6px 10px",
                    border: "1px dashed #9aa4b2",
                    borderRadius: 6,
                    background: "#f7f9ff",
                    fontFamily: "monospace",
                  }}
                >
                  {coupon}
                </span>
                <button
                  className="btn"
                  onClick={onCopy}
                  aria-label="Copy coupon code"
                  title="Copy coupon code"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <span role="img" aria-hidden="true">📋</span> Copy
                </button>
              </div>
            )}
            <h3 className="offer-title">{title}</h3>
            {desc && <p className="offer-desc">{desc}</p>}

            {/* ➕ NEW: Variant note */}
            {wrapper.variantText && (
              <p className="network-note">
                <strong>Note:</strong> This benefit is applicable only on{" "}
                <em>{wrapper.variantText}</em> variant
              </p>
            )}
          </div>
        </div>
      );
    }

    // Flipkart: Offer + scrollable T&C + View Offer
    if (site === "Flipkart") {
      const title = getCI(o, "Offer Title") || titleDefault;
      const terms =
        getCI(o, "Terms and Conditions") ||
        getCI(o, "Terms & Conditions") ||
        getCI(o, "T&C") ||
        "";
      const link = getCI(o, "Link") || linkDefault;

      return (
        <div className="offer-card">
          <div className="offer-info">
            <h3 className="offer-title">{title}</h3>
            {terms && (
              <div
                style={{
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid #ccc",
                  padding: "8px",
                }}
              >
                <strong>Terms &amp; Conditions:</strong>
                <br />
                {terms}
              </div>
            )}
            {link && (
              <button className="btn" onClick={() => window.open(link, "_blank")}>
                View Offer
              </button>
            )}

            {/* ➕ NEW: Variant note */}
            {wrapper.variantText && (
              <p className="network-note">
                <strong>Note:</strong> This benefit is applicable only on{" "}
                <em>{wrapper.variantText}</em> variant
              </p>
            )}
          </div>
        </div>
      );
    }

    // Reliance Digital (generic behavior)
    const title = titleDefault;
    const desc = descDefault;
    const link = linkDefault;

    return (
      <div className="offer-card">
        <div className="offer-info">
          <h3 className="offer-title">{title}</h3>
          {desc && <p className="offer-desc">{desc}</p>}

          {site === "Reliance Digital" && link && (
            <button className="btn" onClick={() => window.open(link, "_blank")}>
              View Offer
            </button>
          )}

          {/* ➕ NEW: Variant note */}
          {wrapper.variantText && (
            <p className="network-note">
              <strong>Note:</strong> This benefit is applicable only on{" "}
              <em>{wrapper.variantText}</em> variant
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="App" style={{ fontFamily: "'Libre Baskerville', serif" }}>
      {/* Floating list of CC/DC (from offer CSVs) above the input */}
      {(marqueeCC.length > 0 || marqueeDC.length > 0) && (
        <div
          style={{
            maxWidth: 1200,
            margin: "14px auto 0",
            padding: "14px 16px",
            background: "#F7F9FC",
            border: "1px solid #E8EDF3",
            borderRadius: 10,
            boxShadow: "0 6px 18px rgba(15,23,42,.06)",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: 16,
              color: "#1F2D45",
              marginBottom: 10,
              display: "flex",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <span>Credit And Debit Cards Which Have Offers</span>
          </div>

          {marqueeCC.length > 0 && (
            <marquee
              direction="left"
              scrollamount="4"
              style={{ marginBottom: 8, whiteSpace: "nowrap" }}
            >
              <strong style={{ marginRight: 10, color: "#1F2D45" }}>
                Credit Cards:
              </strong>
              {marqueeCC.map((name, idx) => (
                <span
                  key={`cc-chip-${idx}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleChipClick(name, "credit")}
                  onKeyDown={(e) =>
                    e.key === "Enter" ? handleChipClick(name, "credit") : null
                  }
                  style={{
                    display: "inline-block",
                    padding: "6px 10px",
                    border: "1px solid #E0E6EE",
                    borderRadius: 9999,
                    marginRight: 8,
                    background: "#fff",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1.2,
                    userSelect: "none",
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.background = "#F0F5FF")
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.background = "#fff")
                  }
                  title="Click to select this card"
                >
                  {name}
                </span>
              ))}
            </marquee>
          )}

          {marqueeDC.length > 0 && (
            <marquee
              direction="left"
              scrollamount="4"
              style={{ whiteSpace: "nowrap" }}
            >
              <strong style={{ marginRight: 10, color: "#1F2D45" }}>
                Debit Cards:
              </strong>
              {marqueeDC.map((name, idx) => (
                <span
                  key={`dc-chip-${idx}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleChipClick(name, "debit")}
                  onKeyDown={(e) =>
                    e.key === "Enter" ? handleChipClick(name, "debit") : null
                  }
                  style={{
                    display: "inline-block",
                    padding: "6px 10px",
                    border: "1px solid #E0E6EE",
                    borderRadius: 9999,
                    marginRight: 8,
                    background: "#fff",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1.2,
                    userSelect: "none",
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.background = "#F0F5FF")
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.background = "#fff")
                  }
                  title="Click to select this card"
                >
                  {name}
                </span>
              ))}
            </marquee>
          )}
        </div>
      )}

      {/* Search / dropdown */}
      <div
        className="dropdown"
        style={{ position: "relative", width: "600px", margin: "20px auto" }}
      >
        <input
          type="text"
          value={query}
          onChange={onChangeQuery}
          placeholder="Type a Credit or Debit Card...."
          className="dropdown-input"
          style={{
            width: "100%",
            padding: "12px",
            fontSize: "16px",
            border: `1px solid ${noMatches ? "#d32f2f" : "#ccc"}`,
            borderRadius: "6px",
          }}
        />
        {query.trim() && !!filteredCards.length && (
          <ul
            className="dropdown-list"
            style={{
              listStyle: "none",
              padding: "10px",
              margin: 0,
              width: "100%",
              maxHeight: "260px",
              overflowY: "auto",
              border: "1px solid #ccc",
              borderRadius: "6px",
              backgroundColor: "#fff",
              position: "absolute",
              zIndex: 1000,
            }}
          >
            {filteredCards.map((item, idx) =>
              item.type === "heading" ? (
                <li
                  key={`h-${idx}`}
                  style={{ padding: "8px 10px", fontWeight: 700, background: "#fafafa" }}
                >
                  {item.label}
                </li>
              ) : (
                <li
                  key={`i-${idx}-${item.display}`}
                  onClick={() => onPick(item)}
                  style={{
                    padding: "10px",
                    cursor: "pointer",
                    borderBottom: "1px solid #f2f2f2",
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.background = "#f7f9ff")
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  {item.display}
                </li>
              )
            )}
          </ul>
        )}
      </div>

      {noMatches && query.trim() && (
        <p style={{ color: "#d32f2f", textAlign: "center", marginTop: 8 }}>
          No matching cards found. Please try a different name.
        </p>
      )}

      {/* Offers by section */}
      {selected && hasAny && !noMatches && (
        <div
          className="offers-section"
          style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}
        >
          {!!dAmazon.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Amazon</h2>
              <div className="offer-grid">
                {dAmazon.map((w, i) => (
                  <OfferCard key={`amz-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}

          {!!dCroma.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Croma</h2>
              <div className="offer-grid">
                {dCroma.map((w, i) => (
                  <OfferCard key={`croma-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}

          {!!dInstamart.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Instamart</h2>
              <div className="offer-grid">
                {dInstamart.map((w, i) => (
                  <OfferCard key={`insta-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}

          {!!dBlinking.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Blinkit</h2>
              <div className="offer-grid">
                {dBlinking.map((w, i) => (
                  <OfferCard key={`blink-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}

          {!!dFlipkart.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Flipkart</h2>
              <div className="offer-grid">
                {dFlipkart.map((w, i) => (
                  <OfferCard key={`flip-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}

          {!!dReliance.length && (
            <div className="offer-group">
              <h2 style={{ textAlign: "center" }}>Offers on Reliance Digital</h2>
              <div className="offer-grid">
                {dReliance.map((w, i) => (
                  <OfferCard key={`rel-${i}`} wrapper={w} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {selected && !hasAny && !noMatches && (
        <p style={{ color: "#d32f2f", textAlign: "center", marginTop: 10 }}>
          No offers for this card
        </p>
      )}

      {selected && hasAny && !noMatches && (
        <button
          onClick={() =>
            window.scrollBy({ top: window.innerHeight, behavior: "smooth" })
          }
          style={{
            position: "fixed",
            right: 20,
            bottom: isMobile ? 250 : 280,
            padding: isMobile ? "12px 15px" : "10px 20px",
            backgroundColor: "#1e7145",
            color: "white",
            border: "none",
            borderRadius: isMobile ? "50%" : 8,
            cursor: "pointer",
            fontSize: 18,
            zIndex: 1000,
            boxShadow: "0 2px 5px rgba(0,0,0,0.2)",
            width: isMobile ? 50 : 140,
            height: 50,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {isMobile ? "↓" : "Scroll Down"}
        </button>
      )}

      <Disclaimer />
    </div>
  );
};

export default HotelOffers;
