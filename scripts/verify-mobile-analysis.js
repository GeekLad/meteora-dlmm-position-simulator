/* Mobile-viewport verification for the compressed Analysis tab.
 * Drives the real dev server with mocked Meteora API data.
 * Usage: node scripts/verify-mobile-analysis.js [--prompt]
 *   --prompt: also run the wallet-prompt chart variant
 */
const puppeteer = require('puppeteer-core');

const BASE = 'http://localhost:9002';
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const POOL = '2qeh7Wt3Au9DjbtJD8GT3J4mnjZu8iFfxSxRKWFZyjcy';
const WALLET = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

// SOL/USDC-like pool: price ~140, bin step 10. Mock pages for the pools list.
const MOCK_PAIR = {
  address: POOL,
  name: 'SOL-USDC',
  token_x: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, is_verified: true },
  token_y: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, is_verified: true },
  reserve_x: '1', reserve_y: '2',
  token_x_amount: 1000, token_y_amount: 140000,
  created_at: 0,
  reward_mint_x: '', reward_mint_y: '',
  pool_config: { bin_step: 10, base_fee_pct: 0, max_fee_pct: 0, protocol_fee_pct: 0 },
  dynamic_fee_pct: 0,
  tvl: 1500000,
  current_price: 140,
  apr: 0, apy: 0,
  has_farm: false, farm_apr: 0, farm_apy: 0,
  volume: { '30m': 0, '1h': 0, '2h': 0, '4h': 0, '12h': 0, '24h': 10 },
  fees: {}, protocol_fees: {}, fee_tvl_ratio: {},
  cumulative_metrics: { volume: 0, fees: 0 },
  is_blacklisted: false,
  launchpad: '',
  tags: [],
};
const rawPairsPage = (pairs, total) => JSON.stringify({ total, pages: 1, current_page: 1, page_size: 1000, data: pairs });

// Simulator bin ID space: price = (1+step/10000)^(id-262144) with decimal adjust
// price = 10^(3) * basis^(id-262144)  (base 9 dec, quote 6 dec → x1000 factor here means
// getPriceFromId multiplies by 10^(9-6)/... see dlmm-sdk-wrapper; id for price p:
function simBinIdForPrice(price, step) {
  // price_per_lamport = price / 10^(base-quote decimals adj) with adjustment applied in getPriceFromBinId:
  // getPriceFromBinId: pricePerLamport = basis^exp, price = pricePerLamport * 10^(9-6)=*1000 → so lamport price = price/1000
  const pricePerLamport = price / 1000;
  const exp = Math.log(pricePerLamport) / Math.log(1 + step / 10000);
  return Math.round(exp) + 262144;
}

// Valid base58 position pubkeys (any valid 32-byte key works; the on-chain
// fetch will fail in tests and the app falls back to API reconstruction).
const POSITION_KEYS = [
  '5Pa9NzABCRHeYGQfNEUyHsREdHYWzMy2jyXKaEXB8dHt',
  '8srbAhCHZVxPzjbd7pQDjRbioDpwfp7Qa9Uxc7TBjnQp',
];

function walletPositionsPage(poolAddr) {
  const step = 10;
  const activePrice = 140.0134; // exact bin price from getPriceFromId with SOL/USDC decimals
  const activeOnChain = simBinIdForPrice(activePrice, step) - 262144; // on-chain bin id space
  const mkPos = (idx, lo, hi, base, quote) => ({
    positionAddress: POSITION_KEYS[idx],
    lowerBinId: lo,
    upperBinId: hi,
    minPrice: 0, maxPrice: 0,
    poolActiveBinId: activeOnChain,
    poolActivePrice: activePrice,
    isOutOfRange: false,
    createdAt: 0,
    unrealizedPnl: {
      balanceTokenX: { amount: base }, balanceTokenY: { amount: quote },
      balances: base * activePrice + quote,
      unclaimedFeeTokenX: { usd: 0 }, unclaimedFeeTokenY: { usd: 0 },
    },
    balances: base * activePrice + quote,
    pnl: 12.34, pnlPctChange: 1.2,
  });
  // Two positions straddling the active price (on-chain bin IDs, offset applied by app)
  const p1 = mkPos(0, activeOnChain - 40, activeOnChain + 39, 8.5, 300);
  const p2 = mkPos(1, activeOnChain - 20, activeOnChain + 59, 4.2, 150);
  return JSON.stringify({ positions: [p1, p2], hasNext: false });
}

const portfolioPage = JSON.stringify({
  pools: [{
    poolAddress: POOL,
    tokenX: 'SOL', tokenY: 'USDC',
    tokenXMint: 'So11111111111111111111111111111111111111112',
    tokenYMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenXIcon: '', tokenYIcon: '',
    binStep: 10, baseFee: 0,
    poolPrice: 140,
    listPositions: ['Pos1', 'Pos2'],
    openPositionCount: 2,
    balances: 1600, pnl: 12.34, pnlPctChange: 1.2,
    unclaimedFees: 0, totalDeposit: 1500, outOfRange: false,
    positionsOutOfRange: [],
  }],
  totalPositions: 2, hasNext: false,
});

async function installMocks(page, { includeWallet = true } = {}) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const g = (re) => url.match(re);
    let match = null;
    const CORS = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    const done = (body, type = 'application/json') =>
      req.respond({ status: 200, contentType: `application/${type}`, body, headers: CORS }).then(() => {}, () => {});

    if (g(/^https:\/\/dlmm\.datapi\.meteora\.ag\/pools\?page=/)) {
      // single page of pools, then stop pagination by returning fewer than page_size
      return done(rawPairsPage([MOCK_PAIR], 1));
    }
    if (g(/^https:\/\/dlmm\.datapi\.meteora\.ag\/pools\/[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      return done(JSON.stringify(MOCK_PAIR));
    }
    if (includeWallet && g(/^https:\/\/dlmm\.datapi\.meteora\.ag\/portfolio\/open\?/)) {
      return done(portfolioPage);
    }
    if (includeWallet && g(/^https:\/\/dlmm\.datapi\.meteora\.ag\/positions\//)) {
      return done(walletPositionsPage(POOL));
    }
    if (g(/^https:\/\/solana-rpc\.publicnode\.com\/?$/)) {
      // make on-chain fetch fail (with CORS headers so fetch resolves and the app's catch runs)
      return req.respond({ status: 500, contentType: 'application/json', body: '{}', headers: CORS }).then(() => {}, () => {});
    }
    if (g(/fonts\.(googleapis|gstatic)\.com/)) {
      return done('', 'css');
    }
    return req.continue().then(() => {}, () => {});
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitAppReady(page) {
  // Ready when the load-position card and its pool search input have rendered.
  await page.waitForFunction(() => {
    return !!document.querySelector('input[placeholder*="Search by token symbol"]');
  }, { timeout: 30000 });
}

async function clickByText(page, rootSel, text) {
  const ok = await page.evaluate((rootSel, text) => {
    const root = rootSel ? document.querySelector(rootSel) : document;
    if (!root) return false;
    const els = Array.from(root.querySelectorAll('button'));
    const el = els.find(e => e.textContent.trim() === text && e.offsetParent !== null);
    if (!el) return false;
    el.click();
    return true;
  }, rootSel, text);
  if (!ok) throw new Error(`Button "${text}" not found${rootSel ? ` in ${rootSel}` : ''}`);
}

async function clickShockButton(page, text) {
  const ok = await page.evaluate((text) => {
    const span = Array.from(document.querySelectorAll('span')).find(s => s.textContent === 'Price shock');
    if (!span) return false;
    const el = Array.from(span.parentElement.querySelectorAll('button'))
      .find(b => b.textContent.trim() === text && b.offsetParent !== null);
    if (!el) return false;
    el.click();
    return true;
  }, text);
  if (!ok) throw new Error(`Shock button "${text}" not found`);
}

async function metrics(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height, width: b.width, x: b.x, y: b.y }; };
    const nav = Array.from(document.querySelectorAll('nav')).find(n => n.getAttribute('aria-label') === 'Simulator sections');
    return {
      innerH: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      scrollY: Math.round(window.scrollY),
      nav: r(nav),
      header: r(document.querySelector('header')),
      chartArea: r(document.querySelector('.h-64.h-full, div[class*="h-64"][class*="w-full"]')),
      analysisCard: (() => {
        const titles = Array.from(document.querySelectorAll('h2, [class*="CardTitle"], div.text-lg'));
        const t = titles.find(e => e.textContent.includes('Analysis'));
        if (!t) return null;
        const card = t.closest('.rounded-lg.border');
        return card ? r(card) : null;
      })(),
      // current price chip
      curPriceChip: (() => {
        const el = Array.from(document.querySelectorAll('div')).find(d =>
          d.className && typeof d.className === 'string'
          && d.className.includes('bg-gradient-to-br from-card to-card/80'));
        return el ? r(el) : null;
      })(),
    };
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

function tokenLabelsOf(labels) {
  return labels.filter(l => l && l.includes('Tokens'));
}
function tokenLabelsCheck(tokenLabels) {
  return tokenLabels.length === 2;
}

(async () => {
  const args = process.argv.slice(2);
  const withPrompt = args.includes('--prompt');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport(MOBILE);
  await installMocks(page, { includeWallet: withPrompt });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('  [pageerror]', String(e && e.message || e).slice(0, 300)));
  page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('  [navigated]', f.url()); });

  // ---------- Load a pool through the real flow ----------
  console.log('1) Loading SOL-USDC pool via search');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitAppReady(page);
  const searchInput = await page.$('input[placeholder*="Search by token"]');
  assert(searchInput, 'pool search input exists');
  await searchInput.type('SOL USDC', { delay: 20 });
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => b.offsetParent && b.textContent.includes('SOL-USDC'));
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent && b.textContent.includes('SOL-USDC'));
    btn.click();
  });

  // Position form appears; create a position: set range + amounts
  console.log('2) Creating a simulated position (Spot, ±5% range, SOL/USDC amounts)');
  await page.waitForFunction(() => !!document.querySelector('input[placeholder="0"]'), { timeout: 20000 });
  // price range fields: PriceBoundField renders <label><div><input/>…; grab input via handle
  const setRangeField = async (label, value) => {
    const handle = await page.evaluateHandle((label) => {
      const lab = Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim() === label);
      return lab ? lab.parentElement.querySelector('input') : null;
    }, label);
    const el = handle.asElement();
    if (!el) { assert(false, `range field "${label}" input found`); return; }
    await el.click({ clickCount: 3 });
    await el.type(value, { delay: 15 });
    // Commit: focus other field triggers blur → commit
    await page.keyboard.press('Tab');
    await sleep(120);
  };
  await setRangeField('Min Price', '133');
  await setRangeField('Max Price', '147');
  const amounts = await page.$$('input[placeholder="0"]');
  assert(amounts.length >= 2, 'SOL and USDC amount inputs exist');
  await amounts[0].type('3');
  await amounts[1].type('420');
  await clickByText(page, null, 'Create position');
  await sleep(600);

  // Wait until analysis card visible (auto-switches to analysis on mobile)
  await page.waitForFunction(() => {
    const t = Array.from(document.querySelectorAll('div.text-lg')).find(e => e.textContent.includes('Analysis'));
    return t && t.offsetParent;
  }, { timeout: 20000 });

  await sleep(400);
  let m = await metrics(page);
  console.log('   metrics:', JSON.stringify(m));

  // ---------- Assertions ----------
  console.log('3) Verifying everything fits above the bottom tab bar');
  assert(m.nav && Math.abs(m.nav.height - 56) <= 2, `bottom nav visible with h≈56 (got ${m.nav && m.nav.height})`);
  assert(m.scrollH <= m.innerH + 1, `no vertical scroll needed (scrollHeight ${m.scrollH} <= viewport ${m.innerH})`);
  assert(m.analysisCard.bottom <= m.nav.top + 1, `analysis card bottom (${Math.round(m.analysisCard.bottom)}) above nav top (${Math.round(m.nav.top)})`);

  console.log('4) Verifying price shock row (single row, Reset/±1% + overflow menu)');
  const shock = await page.evaluate(() => {
    const span = Array.from(document.querySelectorAll('span')).find(s => s.textContent === 'Price shock');
    if (!span) return null;
    const row = span.parentElement;
    const btns = Array.from(row.querySelectorAll('button')).filter(b => b.offsetParent);
    const rowRect = row.getBoundingClientRect();
    return {
      visible: span.offsetParent !== null,
      rowHeight: rowRect.height,
      btnLabels: btns.map(b => b.textContent.trim()),
      tops: btns.map(b => Math.round(b.getBoundingClientRect().top)),
    };
  });
  assert(shock && shock.visible, 'Price shock row visible');
  assert(shock.rowHeight < 40, `single-row shock control height ${shock.rowHeight}px (<40)`);
  assert(shock.btnLabels.join(',') === ['-1%', 'Reset', '+1%', ''].join(','), `mobile shows Reset/±1% + ellipsis (got [${shock.btnLabels}])`);
  assert(new Set(shock.tops).size === 1, `all buttons on one line (tops ${shock.tops})`);

  console.log('5) Verifying compact metrics grid (mobile) with 3 columns');
  const grid = await page.evaluate(() => {
    const g = document.querySelector('.grid.grid-cols-3');
    if (!g || g.offsetParent === null) return null;
    const cells = Array.from(g.children);
    return {
      labels: cells.map(c => c.querySelector('span') && c.querySelector('span').textContent),
      cols: (() => {
        const first = cells[0].getBoundingClientRect();
        const second = cells[1].getBoundingClientRect();
        return Math.abs(first.top - second.top) < 2 ? 3 : 0; // same row → 3 columns
      })(),
    };
  });
  assert(grid, 'compact mobile metrics grid present and visible');
  assert(grid.cols === 3, '3 columns on mobile');
  assert(grid, 'compact mobile metrics grid present and visible');
  assert(grid.cols === 3, '3 columns on mobile');
  // All desktop stats must exist on mobile: 12 core + Cur. Value ( Pocketed only with removed liquidity)
  // Token labels use live symbols (e.g. "SOL Tokens"); match on the "Tokens" suffix.
  const requiredLabels = [
    'Net In.', 'Pos Value', 'Net P&L', 'Unreal. P&L', 'Real. P&L', 'Net P&L',
    'Init Price', 'Price Chg', 'Breakeven',
  ];
  const missing = requiredLabels.filter(l => !grid.labels.some(x => x && x.includes(l)));
  assert(missing.length === 0, `all core stats present on mobile (missing: [${missing}])`);
  const tokenLabels = tokenLabelsOf(grid.labels);
  assert(tokenLabelsCheck(tokenLabels), `both token count stats present on mobile (${JSON.stringify(tokenLabels)})`);
  assert(grid.labels.length >= 12, `full stat count on mobile (got ${grid.labels.length})`);
  const hasAvg = grid.labels.some(l => l && (l.includes('Avg') || l.includes('Price Paid') || l.includes('Price Sold')));
  assert(hasAvg, 'avg price stat present on mobile');
  const hasCurrentValue = grid.labels.some(l => l && l.includes('Cur. Value'));
  assert(hasCurrentValue, 'current value stat present on mobile');

  // Related-value grouping: the second "Net P&L" (%-return) must sit directly
  // under the first "Net P&L" (absolute), i.e. share the same column x position.
  const grouping = await page.evaluate(() => {
    const g = document.querySelector('.grid.grid-cols-3');
    const cells = Array.from(g.children).map(c => ({
      label: c.querySelector('span').textContent,
      x: Math.round(c.getBoundingClientRect().x),
      top: Math.round(c.getBoundingClientRect().top),
      bottom: Math.round(c.getBoundingClientRect().bottom),
    }));
    const pnlCells = cells.filter(c => c.label === 'Net P&L');
    const rows = [];
    for (const c of cells) {
      const row = rows.find(r => Math.abs(r.top - c.top) < 3);
      if (row) row.cells.push(c);
      else rows.push({ top: c.top, cells: [c] });
    }
    return { pnlCells, rowCount: rows.length };
  });
  assert(grouping.pnlCells.length === 2, `two Net P&L cells (got ${grouping.pnlCells.length})`);
  assert(grouping.pnlCells[0].x === grouping.pnlCells[1].x,
    `Net P&L % aligned directly under Net P&L (x ${grouping.pnlCells[0].x} vs ${grouping.pnlCells[1].x})`);
  // Un/Realized P&L row: they should share a row (related pair, side by side)
  const pnlRow = await page.evaluate(() => {
    const g = document.querySelector('.grid.grid-cols-3');
    const cells = Array.from(g.children).map(c => ({
      label: c.querySelector('span').textContent,
      top: Math.round(c.getBoundingClientRect().top),
    }));
    const u = cells.find(c => c.label === 'Unreal. P&L');
    const r = cells.find(c => c.label === 'Real. P&L');
    return u && r ? Math.abs(u.top - r.top) < 3 : false;
  });
  assert(pnlRow, 'Unrealized and Realized P&L share a row');

  const binsFooter = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('p')).find(x => x.textContent.includes('bins'));
    if (!p || p.offsetParent === null) return null;
    return p.textContent.replace(/\s+/g, ' ').trim();
  });
  assert(binsFooter && binsFooter.includes('bins'), `bins footer visible on mobile ("${binsFooter}")`);

  const toggleHiddenMobile = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Display Actual'));
    if (!row) return 'missing';
    const box = row.closest('.bg-card\\/80') || row.parentElement;
    return getComputedStyle(box).display;
  });
  assert(toggleHiddenMobile === 'none', `USD-value toggle hidden on mobile (got ${toggleHiddenMobile})`);
  assert(m.chartArea.height <= 280, `chart height bounded on mobile (${m.chartArea.height}px)`);

  console.log('6) Exercising Price shock taps end-to-end');
  const priceAt = () => page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div')).find(d =>
      d.className && typeof d.className === 'string' && d.className.includes('from-card to-card/80'));
    if (!el) return null;
    const rows = el.querySelectorAll('div');
    return rows.length ? rows[rows.length - 1].textContent.trim() : el.textContent;
  });
  const p0 = await priceAt();
  await clickShockButton(page, '+1%');
  await sleep(700);
  const p1 = await priceAt();
  assert(p0 !== p1, `+1% tap changed current price chip (${p0} → ${p1})`);

  // +1% is now hidden (it was tapped? no — +1% is always visible; fine
  // Reset back and check
  await clickShockButton(page, 'Reset');
  await sleep(700);
  const p2 = await priceAt();
  assert(Math.abs(parseFloat(p2) - parseFloat(p0)) < 1e-6, `Reset restored price (${p2})`);

  // Overflow menu
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="More price shocks"]');
    if (!btn) throw new Error('no overflow button');
    btn.click();
  });
  await page.waitForFunction(() => !!document.querySelector('[role="dialog"], .radix-popover-content, [data-radix-popper-content-wrapper]'), { timeout: 5000 });
  console.log('7) Popover open — choosing -25%');
  const pBefore = await priceAt();
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
    const btn = Array.from(wrapper.querySelectorAll('button')).find(b => b.textContent.trim() === '-25%');
    btn.click();
  });
  await sleep(800);
  const pAfter = await priceAt();
  assert(pBefore !== pAfter, `popover -25% changed price (${pBefore} → ${pAfter})`);
  const popGone = await page.evaluate(() => !document.querySelector('[data-radix-popper-content-wrapper]'));
  assert(popGone, 'popover closes after selection');
  const mAfterShock = await metrics(page);
  assert(mAfterShock.scrollH <= mAfterShock.innerH + 1, `still fits after -25% shock (scrollHeight ${mAfterShock.scrollH})`);
  await sleep(300);
  console.log('   post-shock state:', await page.evaluate(() => ({
    href: location.href,
    hasAnalysis: !!Array.from(document.querySelectorAll('div.text-lg')).find(e => e.textContent.includes('Analysis')),
  })));

  // Reset via popover? just use Reset button
  await clickShockButton(page, 'Reset');
  await sleep(500);

  console.log('8a) Positions tab round-trip (same session, mobile)');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
    const pos = btns.find(b => b.textContent.includes('Positions'));
    pos.click();
  });
  await sleep(500);
  const posSection = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('div.text-sm.font-medium'));
    const listHeader = titles.find(d => d.textContent.trim() === 'Positions' && d.offsetParent !== null);
    const posCard = Array.from(document.querySelectorAll('div')).find(d =>
      d.offsetParent !== null && d.className.includes && d.className.includes('rounded-md border p-3')
      && (d.textContent.includes('Simulated') || d.textContent.includes('In range')));
    const analysisTitle = Array.from(document.querySelectorAll('div.text-lg')).find(e => e.textContent.includes('Analysis'));
    return {
      listHeader: !!listHeader,
      hasPositionCard: !!posCard,
      analysisHidden: !analysisTitle || analysisTitle.offsetParent === null,
    };
  });
  assert(posSection.listHeader, 'Positions tab shows positions list');
  assert(posSection.hasPositionCard, 'Positions tab shows the created position card');
  assert(posSection.analysisHidden, 'Analysis card hidden while on Positions tab');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
    const a = btns.find(b => b.textContent.includes('Analysis'));
    a.click();
  });
  await sleep(400);
  const back = await metrics(page);
  assert(back.scrollH <= back.innerH + 1, 'analysis still fits after tab round-trip');
  assert(back.analysisCard.bottom <= back.nav.top + 1, 'analysis card still above nav after round-trip');

  console.log('8a-2) Remove 50% liquidity → Pocketed stat appears');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
    btns.find(b => b.textContent.includes('Positions')).click();
  });
  await sleep(500);
  await page.evaluate(() => {
    const remove = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent && b.textContent.trim() === 'Remove');
    remove.click();
  });
  await page.waitForFunction(() => {
    const slider = document.querySelector('[role="slider"]');
    return !!slider;
  }, { timeout: 10000 });
  // keep default 50%? default is 100%; set slider to 50 via keyboard
  await page.evaluate(() => {
    const slider = document.querySelector('[role="slider"]');
    slider.focus();
  });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  // slider: 100 → step is 1; press ~50 times is slow; instead set via keyboard: shift? Just press ArrowLeft 50 times quickly
  for (let i = 0; i < 48; i++) await page.keyboard.press('ArrowLeft');
  await sleep(200);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
    const apply = btns.find(b => /Remove \d+%/.test(b.textContent));
    apply.click();
  });
  await sleep(700);
  // back to analysis
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
    btns.find(b => b.textContent.includes('Analysis')).click();
  });
  await sleep(600);
  const pocketed = await page.evaluate(() => {
    const g = document.querySelector('.grid.grid-cols-3');
    if (!g) return { found: false };
    const cells = Array.from(g.children).map(c => ({ label: c.querySelector('span').textContent, x: Math.round(c.getBoundingClientRect().x), top: Math.round(c.getBoundingClientRect().top) }));
    const cur = cells.find(c => c.label === 'Cur. Value');
    const pk = cells.find(c => c.label === 'Pocketed');
    return { found: true, cur, pk, count: cells.length };
  });
  assert(pocketed.found, 'grid renders after removal');
  assert(!!pocketed.pk, 'Pocketed stat appears after removal');
  assert(pocketed.pk.top === pocketed.cur.top,
    `Cur. Value and Pocketed share a row (tops ${pocketed.cur.top} vs ${pocketed.pk.top})`);
  const mPk = await metrics(page);
  assert(mPk.scrollH <= mPk.innerH + 1, `still fits with Pocketed stat (scrollHeight ${mPk.scrollH})`);

  // Positions tab still works on mobile (kept here so screenshots can be captured per section)
  const shotPos = process.argv.includes('--shots');
  if (shotPos) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
      btns.find(b => b.textContent.includes('Positions')).click();
    });
    await sleep(600);
    await page.screenshot({ path: '/tmp/mobile-positions.png' });
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('nav[aria-label="Simulator sections"] button'));
      btns.find(b => b.textContent.includes('Analysis')).click();
    });
    await sleep(600);
  }

  console.log('8b) Regression checks in a desktop-width tab (setViewport reloads, so use a fresh tab)');
  const dpage = await browser.newPage();
  await dpage.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await installMocks(dpage, { includeWallet: false });
  dpage.on('pageerror', e => console.log('  [pageerror]', String(e && e.message || e).slice(0, 300)));
  await dpage.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitAppReady(dpage);
  const dsearch = await dpage.$('input[placeholder*="Search by token symbol"]');
  await dsearch.type('SOL USDC', { delay: 15 });
  await dpage.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.offsetParent && b.textContent.includes('SOL-USDC')), { timeout: 15000 });
  await dpage.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.offsetParent && b.textContent.includes('SOL-USDC')).click());
  await dpage.waitForFunction(() => !!document.querySelector('input[placeholder="0"]'), { timeout: 20000 });
  const damounts = await dpage.$$('input[placeholder="0"]');
  await damounts[0].type('3');
  await damounts[1].type('420');
  await dpage.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Create position').click());
  await dpage.waitForFunction(() => {
    const t = Array.from(document.querySelectorAll('div.text-lg')).find(e => e.textContent.includes('Analysis'));
    return t && t.offsetParent;
  }, { timeout: 20000 });
  await sleep(400);

  const desktopShock = await dpage.evaluate(() => {
    const span = Array.from(document.querySelectorAll('span')).find(s => s.textContent === 'Price shock');
    if (!span) return null;
    const row = span.parentElement;
    const btns = Array.from(row.querySelectorAll('button')).filter(b => b.offsetParent);
    const overflowBtn = row.querySelector('button[aria-label="More price shocks"]');
    const overflow = overflowBtn && overflowBtn.offsetParent !== null;
    const rect = row.getBoundingClientRect();
    return { labels: btns.map(b => b.textContent.trim()), hasOverflow: overflow, wraps: btns.some(b => Math.abs(b.getBoundingClientRect().top - rect.top) > 60) };
  });
  console.log('   desktop shock row:', JSON.stringify(desktopShock));
  assert(desktopShock && !desktopShock.hasOverflow, 'desktop hides ellipsis overflow button');
  assert(desktopShock.labels.includes('-25%') && desktopShock.labels.includes('+25%'), 'desktop shows wide shocks inline');
  const desktopFooter = await dpage.evaluate(() => {
    const p = Array.from(document.querySelectorAll('p')).find(x => x.textContent.includes('bins'));
    const g3 = document.querySelector('.grid.grid-cols-3');
    const lab = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Display Actual'));
    return {
      footerVisible: p && p.offsetParent !== null,
      compactGridHidden: !g3 || g3.offsetParent === null,
      usdToggleVisible: lab && lab.offsetParent !== null,
    };
  });
  assert(desktopFooter.footerVisible, 'bins footer visible on desktop');
  assert(desktopFooter.compactGridHidden, 'compact 3-col grid hidden on desktop');
  assert(desktopFooter.usdToggleVisible, 'USD-value toggle visible on desktop');
  if (process.argv.includes('--shots')) {
    await dpage.screenshot({ path: '/tmp/desktop-analysis.png' });
  }
  await dpage.close().catch(() => {});

  if (withPrompt) {
    console.log('9) Wallet-prompt variant (promptSetInitialPrice)');
    // Reload fresh and load wallet positions via Wallet tab
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
    // Dev-server HMR websocket can make networkidle2 resolve pre-hydration; poll for the UI.
    for (let i = 0; i < 30; i++) {
      const ready = await page.evaluate(() => (
        !!document.querySelector('input[placeholder*="Search by token symbol"]')
        && !!document.querySelector('[role="tab"]')
      ));
      if (ready) break;
      if (i === 29) throw new Error('app never became ready after goto');
      await sleep(1000);
    }
    await page.waitForFunction(() => !!document.querySelector('[role="tab"]'), { timeout: 15000 });
    // Radix tabs activate on mousedown; el.click() alone never fires it.
    await page.evaluate(() => {
      const w = Array.from(document.querySelectorAll('[role="tab"]')).find(b => b.textContent.includes('Read Wallet'));
      w.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      w.focus();
      w.click();
    });
    await page.waitForFunction(() => !!document.querySelector('input[placeholder="Solana wallet address"]'), { timeout: 15000 });
    const walletInput = await page.$('input[placeholder="Solana wallet address"]');
    await walletInput.type(WALLET, { delay: 10 });
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Load');
      return btn && !btn.disabled;
    }, { timeout: 10000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Load');
      btn.click();
    });
    // one pair with one pool → tap the pair row to start loading
    await page.waitForFunction(() => {
      const pairs = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent && b.querySelector('span.font-semibold') && /pool|positions/.test(b.textContent));
      return pairs.length > 0;
    }, { timeout: 20000 });
    await page.evaluate(() => {
      const pairs = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent && b.querySelector('span.font-semibold') && /pool|positions/.test(b.textContent));
      pairs[0].click();
    });
    await page.waitForFunction(() => {
      const t = Array.from(document.querySelectorAll('div.text-lg')).find(e => e.textContent.includes('Analysis'));
      return t && t.offsetParent;
    }, { timeout: 30000 });
    await sleep(800);
    const wm = await metrics(page);
    assert(wm.scrollH <= wm.innerH + 1, `wallet-prompt view fits above nav (scrollHeight ${wm.scrollH})`);
    const walletDebug = await page.evaluate(() => {
      const banner = Array.from(document.querySelectorAll('div')).find(d =>
        d.offsetParent && typeof d.className === 'string' && d.className.includes('bg-primary/10') && d.textContent.includes('Set the initial price'));
      const texts = Array.from(new Set(Array.from(document.querySelectorAll('main div')).map(d => d.textContent.trim()).filter(t => t && t.length < 70))).slice(0, 30);
      return { banner: !!banner, texts };
    });
    console.log('   wallet state:', JSON.stringify(walletDebug, null, 1).slice(0, 1500));
    const promptVisible = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div')).find(d =>
        d.textContent.includes('Set the initial price') && d.className.includes('bg-primary/10'));
      return el && el.offsetParent !== null;
    });
    assert(!!promptVisible, 'initial-price prompt banner visible');
    // Confirm the USD-value toggle row is display:none on mobile
    const toggleHidden = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Display Actual'));
      if (!row) return 'missing';
      const box = row.closest('.bg-card\\/80') || row.parentElement;
      return getComputedStyle(box).display;
    });
    assert(toggleHidden === 'none', `USD-value toggle hidden on mobile (got ${toggleHidden})`);
  }

  const fs = require('fs');
  await page.setViewport(MOBILE);
  await sleep(300);
  await page.screenshot({ path: '/tmp/mobile-analysis-final.png', fullPage: false });
  console.log('Saved screenshot /tmp/mobile-analysis-final.png');

  await browser.close();
  console.log('ALL CHECKS PASSED');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });