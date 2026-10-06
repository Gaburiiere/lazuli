/* =========================================================
   Lazúli Connect — liga o site ao painel (SaaS) da Lazúli
   ---------------------------------------------------------
   • Cardápio, preços e disponibilidade vêm do painel (fonte única).
   • Visitas, produtos vistos, carrinho, checkout e pedidos vão para o painel.
   • Se o painel estiver fora do ar, o site continua funcionando sozinho
     (cardápio do próprio arquivo + finalização pelo WhatsApp).
   • Nenhum segredo fica aqui: só endereços públicos.
   • Google Analytics 4 / Meta Pixel (se configurados no painel) só carregam
     depois que o visitante aceita cookies de medição (LGPD).
   ========================================================= */
(function () {
  "use strict";
  var LZ = { enabled: false, api: "", loja: "lazuli", sid: "", aid: "", utm: {}, store: null };
  var queue = [], cartSnap = null, timer = 0, seen = {};

  function safeGet(st, k) { try { return st.getItem(k); } catch (e) { return null; } }
  function safeSet(st, k, v) { try { st.setItem(k, v); } catch (e) {} }
  function rid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)); }

  LZ.init = function (config) {
    var api = (config && config.painelApi) || "";
    if (!api) return false;
    LZ.api = String(api).replace(/\/$/, "");
    LZ.loja = config.loja || "lazuli";
    LZ.enabled = true;
    LZ.aid = safeGet(localStorage, "lz-aid") || rid(); safeSet(localStorage, "lz-aid", LZ.aid);
    LZ.sid = safeGet(sessionStorage, "lz-sid") || rid(); safeSet(sessionStorage, "lz-sid", LZ.sid);
    var p = new URLSearchParams(location.search), utm = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_content"].forEach(function (k) { if (p.get(k)) utm[k.replace("utm_", "")] = p.get(k).slice(0, 100); });
    if (!utm.source && document.referrer && document.referrer.indexOf(location.host) < 0) {
      try { var h = new URL(document.referrer).hostname; utm.source = /instagram/.test(h) ? "instagram" : /google/.test(h) ? "google" : /facebook|fb\./.test(h) ? "facebook" : /whatsapp|wa\.me/.test(h) ? "whatsapp" : h; } catch (e) {}
    }
    if (Object.keys(utm).length) safeSet(sessionStorage, "lz-utm", JSON.stringify(utm));
    try { LZ.utm = JSON.parse(safeGet(sessionStorage, "lz-utm") || "{}"); } catch (e) { LZ.utm = {}; }
    addEventListener("pagehide", function () { LZ.flush(true); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") LZ.flush(true); });
    return true;
  };

  function url(path) { return LZ.api + "/api/public/" + encodeURIComponent(LZ.loja) + path; }
  function getJSON(path, ms) {
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 3500);
    return fetch(url(path), { signal: ctrl ? ctrl.signal : undefined, credentials: "omit" })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  /* ---------- Preço: mesma regra do servidor (o servidor recalcula tudo no pedido) ---------- */
  function unitPrice(p, o) {
    var best = null, bestKeys = -1;
    (p.variants || []).forEach(function (v) {
      var keys = Object.keys(v.match);
      if (keys.every(function (k) { return o[k] === v.match[k]; }) && keys.length > bestKeys) { best = v; bestKeys = keys.length; }
    });
    if (best) return (best.promoPriceCents != null ? best.promoPriceCents : best.priceCents) / 100;
    if (p.basePriceCents == null) return null;
    return (p.promoPriceCents != null ? p.promoPriceCents : p.basePriceCents) / 100;
  }

  /** Converte o cardápio do painel para o formato que o site já usa (PRODUCTS). */
  LZ.toSite = function (cat) {
    return cat.products.map(function (p) {
      return {
        id: p.slug, _pid: p.id, group: p.group, name: p.name, cat: p.subtitle || p.category || "", img: p.image || "", fit: p.fit || "cover",
        desc: p.description || "", step: p.step, min: p.min, byCento: p.soldBy === "cento",
        mixed: (p.options || []).some(function (g) { return g.type === "mix"; }),
        available: p.available !== false, promo: p.promoPriceCents != null || (p.variants || []).some(function (v) { return v.promoPriceCents != null; }),
        opts: (p.options || []).map(function (g) {
          return {
            k: g.key, label: g.label, type: g.type, step: g.step,
            values: g.type === "chips" ? g.values.map(function (v) { var x = { v: v.v }; if (v.sub) x.sub = v.sub; if (v.tag) x.tag = v.tag; return x; }) : g.values.map(function (v) { return v.v; }),
            showIf: g.showIf ? { k: g.showIf.key, v: g.showIf.value } : undefined
          };
        }),
        note: p.note || "",
        addons: (p.addons || []).filter(function (a) { return a && a.id && a.name; }).map(function (a) { return { id: String(a.id), name: String(a.name), price: a.priceCents == null ? null : a.priceCents / 100 }; }),
        price: function (o) { return unitPrice(p, o || {}); }
      };
    });
  };

  LZ.loadCatalog = function () {
    if (!LZ.enabled) return Promise.resolve(null);
    return getJSON("/catalog", 3500).then(function (c) {
      safeSet(localStorage, "lz-catalog", JSON.stringify(c));
      return LZ.toSite(c);
    }).catch(function () {
      // painel indisponível: usa a última versão recebida (se houver) ou o cardápio do arquivo
      try { var c = JSON.parse(safeGet(localStorage, "lz-catalog") || "null"); return c ? LZ.toSite(c) : null; } catch (e) { return null; }
    });
  };
  LZ.loadConfig = function () {
    if (!LZ.enabled) return Promise.resolve(null);
    return getJSON("/config", 3000).then(function (c) { LZ.store = c; if (c && c.tracking) setupTracking(c.tracking); return c; }).catch(function () { return null; });
  };

  /* ---------- Medição de terceiros (somente com consentimento) ---------- */
  var TR = { ga4: null, pixel: null, on: false };
  function consent() { return safeGet(localStorage, "lz-consent"); }
  function cookie(n) { var m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; }
  function loadScript(src) { var sc = document.createElement("script"); sc.async = true; sc.src = src; document.head.appendChild(sc); }
  function startTracking() {
    if (TR.on) return; TR.on = true;
    if (TR.ga4) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      loadScript("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(TR.ga4));
      window.gtag("js", new Date()); window.gtag("config", TR.ga4);
    }
    if (TR.pixel && !window.fbq) {
      var f = window.fbq = function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
      if (!window._fbq) window._fbq = f; f.push = f; f.loaded = true; f.version = "2.0"; f.queue = [];
      loadScript("https://connect.facebook.net/en_US/fbevents.js");
      window.fbq("init", TR.pixel); window.fbq("track", "PageView");
    }
  }
  function banner() {
    if (document.getElementById("lz-consent")) return;
    var b = document.createElement("div");
    b.id = "lz-consent"; b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Preferências de cookies");
    b.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;background:#fff;color:#22405f;border:1px solid #c3ddf1;border-radius:16px;box-shadow:0 10px 30px rgba(20,38,58,.18);padding:14px 16px;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif";
    b.innerHTML = '<p style="margin:0 0 10px">Usamos cookies de medição (Google Analytics e Meta) para entender as visitas e melhorar nossos anúncios. Você pode recusar sem prejuízo para o seu pedido.</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" data-c="recusado" style="padding:8px 14px;border-radius:10px;border:1px solid #9fc7e8;background:#fff;color:#22405f;cursor:pointer;font:inherit">Recusar</button>' +
      '<button type="button" data-c="aceito" style="padding:8px 14px;border-radius:10px;border:0;background:#2f6fa6;color:#fff;cursor:pointer;font:inherit">Aceitar</button></div>';
    b.addEventListener("click", function (e) { var c = e.target && e.target.getAttribute && e.target.getAttribute("data-c"); if (c) LZ.setConsent(c); });
    document.body.appendChild(b);
  }
  function setupTracking(t) {
    TR.ga4 = t.ga4 || null; TR.pixel = t.metaPixel || null;
    if (!TR.ga4 && !TR.pixel) return;
    var fbclid = new URLSearchParams(location.search).get("fbclid");
    if (fbclid) safeSet(sessionStorage, "lz-fbc", "fb.1." + Date.now() + "." + fbclid.slice(0, 150));
    var c = consent();
    if (c === "aceito") startTracking(); else if (c !== "recusado") banner();
  }
  /** Chamado pelos botões do aviso (ou por um link "Preferências de cookies" do site). */
  LZ.setConsent = function (c) {
    safeSet(localStorage, "lz-consent", c === "aceito" ? "aceito" : "recusado");
    var b = document.getElementById("lz-consent"); if (b) b.remove();
    if (c === "aceito") startTracking();
  };
  LZ.hasTracking = function () { return !!(TR.ga4 || TR.pixel); };
  LZ.cookiePrefs = function () { try { localStorage.removeItem("lz-consent"); } catch (e) {} if (TR.ga4 || TR.pixel) banner(); };
  function mirror(name, slug) {
    if (!TR.on) return;
    var map = { product_view: ["view_item", "ViewContent"], add_to_cart: ["add_to_cart", "AddToCart"], begin_checkout: ["begin_checkout", "InitiateCheckout"] }[name];
    if (!map) return;
    try {
      if (TR.ga4 && window.gtag) window.gtag("event", map[0], slug ? { currency: "BRL", items: [{ item_id: slug }] } : { currency: "BRL" });
      if (TR.pixel && window.fbq) window.fbq("track", map[1], slug ? { content_ids: [slug], content_type: "product" } : {});
    } catch (e) {}
  }
  function trackingIds() {
    if (consent() !== "aceito" || (!TR.ga4 && !TR.pixel)) return null;
    var ids = {}, ga = cookie("_ga"), fbp = cookie("_fbp"), fbc = cookie("_fbc") || safeGet(sessionStorage, "lz-fbc");
    if (ga) { var parts = ga.split("."); if (parts.length >= 4) ids.gaClientId = parts.slice(-2).join("."); }
    if (fbp) ids.fbp = fbp.slice(0, 120);
    if (fbc) ids.fbc = fbc.slice(0, 200);
    return Object.keys(ids).length ? ids : null;
  }

  /* ---------- Eventos ---------- */
  LZ.track = function (name, opts) {
    if (!LZ.enabled) return;
    opts = opts || {};
    if (opts.once) { var key = name + ":" + (opts.product || ""); if (seen[key]) return; seen[key] = 1; }
    if (opts.session) { var sk = "lz-ev-" + name; if (safeGet(sessionStorage, sk)) return; safeSet(sessionStorage, sk, "1"); }
    queue.push({ name: name, productSlug: opts.product, props: opts.props, at: Date.now() });
    mirror(name, opts.product);
    clearTimeout(timer); timer = setTimeout(function () { LZ.flush(false); }, 1500);
  };
  LZ.cart = function (items) {
    if (!LZ.enabled) return;
    cartSnap = items.map(function (i) { var x = { slug: i.id, options: i.o, qty: i.qty }; if (i.a && i.a.length) x.addonIds = i.a; return x; });
    clearTimeout(timer); timer = setTimeout(function () { LZ.flush(false); }, 1500);
  };
  LZ.flush = function (beacon) {
    if (!LZ.enabled || (!queue.length && !cartSnap)) return;
    if (!queue.length) queue.push({ name: "page_view", at: Date.now(), props: { heartbeat: true } });
    var body = JSON.stringify({ sessionId: LZ.sid, anonymousId: LZ.aid, utm: LZ.utm, events: queue.splice(0, 30), cart: cartSnap || undefined });
    cartSnap = null;
    try {
      if (beacon && navigator.sendBeacon && navigator.sendBeacon(url("/events"), new Blob([body], { type: "text/plain" }))) return;
      fetch(url("/events"), { method: "POST", body: body, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "omit" }).catch(function () {});
    } catch (e) {}
  };

  /* ---------- Pedido ---------- */
  LZ.order = function (payload) {
    payload.sessionId = LZ.sid; payload.anonymousId = LZ.aid;
    var ids = trackingIds(); if (ids) payload.tracking = ids; // só com consentimento
    LZ.flush(false);
    return fetch(url("/orders"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "omit" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || "Não foi possível registrar o pedido."); e.status = r.status; throw e; }
          return j;
        });
      }, function () { var e = new Error("Sem conexão com o painel."); e.network = true; throw e; });
  };

  /* ---------- Orçamento (subtotal, taxa, desconto e total calculados pelo painel) ---------- */
  var quoteCtrl = null;
  LZ.quote = function (payload) {
    if (!LZ.enabled) return Promise.reject(new Error("off"));
    if (quoteCtrl && quoteCtrl.abort) quoteCtrl.abort();
    quoteCtrl = "AbortController" in window ? new AbortController() : null;
    var t = setTimeout(function () { if (quoteCtrl) quoteCtrl.abort(); }, 5000);
    return fetch(url("/quote"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "omit", signal: quoteCtrl ? quoteCtrl.signal : undefined })
      .then(function (r) {
        clearTimeout(t);
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 404 || r.status === 405) { var n = new Error("indisponivel"); n.unsupported = true; throw n; }
          if (!r.ok) { var e = new Error(j.error || "Não foi possível calcular o total."); e.status = r.status; e.body = j; throw e; }
          return j;
        });
      });
  };

  /* ---------- Acompanhar pedido (só número, status, linha do tempo, total e pagamento) ---------- */
  LZ.orderStatus = function (code) {
    if (!LZ.enabled) return Promise.reject(new Error("off"));
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(code || "")) return Promise.reject(new Error("Código inválido."));
    return getJSON("/orders/" + encodeURIComponent(code), 6000);
  };

  window.LZ = LZ;
})();
