// Browser assertions run through the existing owned-CDP E2E harness.
export async function productChecks({ evaluate, click, setValue, waitFor, expect, cdp, screenshot, setViewport, holdWorker, releaseWorkers }) {
  const select = () => evaluate("Number(document.querySelector('#capture [aria-current]')?.dataset.position)");
  const press = async (key, code = key, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  };
  const runLesson = async id => {
    const before = await evaluate('window.__lab.runCount');
    await click(`[data-lesson="${id}"]`);
    await waitFor(`window.__lab.runCount === ${before + 1}`);
    return evaluate('window.__lab.lastResult');
  };
  const cancelledRun = await evaluate('window.__lab.runCount');
  await holdWorker(() => click('#run-button'));
  await expect(await evaluate("!document.querySelector('#cancel-button').disabled"), 'pending run cannot be cancelled');
  await click('#cancel-button');
  await releaseWorkers();
  await expect(await evaluate('window.__lab.runCount') === cancelledRun, 'cancelled Worker committed');
  await expect(await evaluate("document.querySelector('#run-status').textContent.includes('cancelled')"), 'cancellation receipt missing');
  await setValue('#page-size', 16);
  await setValue('#page-count', 4);
  await setValue('#request-id', 'product');
  await setValue('#append-tokens', 17);
  await click('#append-button');
  const paging = await evaluate("document.querySelector('#paging-summary').textContent");
  for (const [id, pass, work] of [['baseline', true, 6], ['overwrite', false, 6], ['recompute', true, 21]]) {
    const result = await runLesson(id);
    await expect(result.comparison.passes === pass && result.workSummary.totalRecomputeTokens === work, `lesson ${id} did not run engine`);
    await expect(await evaluate("document.querySelector('#paging-summary').textContent") === paging, 'preset reset paging');
    await expect(await evaluate("document.querySelector('#run-identity').textContent.includes(String(window.__lab.runCount))"), 'missing real run identity');
    await evaluate('window.scrollTo(0,0)');
    await screenshot(`product-lesson-${id}.png`);
  }
  await runLesson('overwrite');
  await click('#previous-position');
  await expect(await select() === 0, 'previous boundary');
  await expect(await evaluate("document.querySelector('#previous-position').disabled"), 'previous not disabled');
  await click('#first-divergence-button');
  await expect(await select() === 1, 'first divergence');
  await click('#next-position');
  await expect(await select() === 2, 'next');
  await evaluate("document.querySelector('#capture [aria-current]').focus()");
  await press('End');
  await expect(await select() === 5, 'End');
  await press('ArrowRight');
  await expect(await select() === 5, 'right boundary');
  await press('Home');
  await expect(await select() === 0, 'Home');
  await press('ArrowRight');
  await expect(await select() === 1, 'right');
  await press('ArrowLeft');
  await expect(await select() === 0, 'left');
  await evaluate("document.querySelector('#tokens-input').focus()");
  await press('End');
  await expect(await select() === 0, 'input navigation stole capture selection');
  await setValue('#tokens-input', '1,2,3');
  await expect(await evaluate("document.querySelector('#draft-status').textContent.length > 0"), 'draft does not warn about previous result');
  const beforeShortcut = await evaluate('window.__lab.runCount');
  await press('Enter', 'Enter', 2);
  await waitFor(`window.__lab.runCount === ${beforeShortcut + 1}`);
  await runLesson('baseline');
  await expect(await evaluate("document.querySelector('#first-divergence-button').disabled"), 'no-divergence button not disabled');
  await click('#export-button');
  await evaluate("document.querySelector('#import-input').value = document.querySelector('#export-output').value");
  const beforeImport = await evaluate('window.__lab.runCount');
  await click('#import-button');
  await waitFor(`window.__lab.runCount === ${beforeImport + 1}`);
  const identity = await evaluate('JSON.stringify(window.__lab.lastResult)');
  const count = await evaluate('window.__lab.runCount');
  await evaluate("document.querySelector('#capture .capture-col[data-position=\"2\"]').focus()");
  // Language click via DOM leaves the focused capture node in place: assert identity, not restored focus.
  await click('#lang-button');
  await expect(await evaluate('document.documentElement.lang') === 'zh', 'language not Chinese');
  await expect(await evaluate("document.activeElement?.dataset.position === '2'"), 'language destroyed capture focus');
  await expect(await evaluate('window.__lab.runCount') === count, 'translation re-ran experiment');
  await expect(await evaluate('JSON.stringify(window.__lab.lastResult)') === identity, 'translation changed numerical result');
  const untranslated = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('h1,.lede,.hint,legend,th,[aria-label],[title],#step-detail,#paging-status,#import-status')];
    return nodes.filter(n => !n.closest('[hidden]')).flatMap(n => [n.textContent, n.getAttribute('aria-label'), n.getAttribute('title')])
      .filter(t => t && /\\b(Position|Select position|Imported|Capacity|Layer)\\b/.test(t));
  })()`);
  await expect(untranslated.length === 0, `English action text in Chinese: ${untranslated}`);
  await expect(await evaluate("/已载入/.test(document.querySelector('#import-status').textContent)"), 'import receipt not translated');
  for (const theme of ['light', 'dark', 'system']) {
    await setValue('#theme-select', theme);
    await expect(await evaluate('document.documentElement.dataset.themePreference') === theme, 'theme preference');
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await waitFor("document.documentElement.dataset.theme === 'dark'");
  await setValue('#theme-select', 'light');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await expect(await evaluate('document.documentElement.dataset.theme') === 'light', 'explicit theme followed system');
  for (const width of [390, 768, 1280]) {
    await setViewport(width, 900);
    for (const theme of ['light', 'dark']) {
      await setValue('#theme-select', theme);
      await evaluate('window.scrollTo(0,0)');
      await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await expect(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `overflow ${width}/${theme}`);
      await expect(await evaluate("[...document.querySelectorAll('#run-button,#lang-button,#theme-select,[data-lesson]')].every(n=>n.getBoundingClientRect().height >= 44)"), 'small primary control');
      if (width === 1280) await expect(await evaluate("document.querySelector('#step-detail').getBoundingClientRect().top < 850"), 'selected step below initial desktop viewport');
      await screenshot(`product-${width}-${theme}.png`);
    }
  }
  // 200% text zoom stresses actual text reflow; 640 CSS viewport covers 1280px browser zoom reflow.
  await setViewport(640, 800);
  await evaluate("document.documentElement.style.fontSize = '200%'");
  await expect(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), '200% text overflow');
  await screenshot('product-200-percent.png');
  await evaluate("document.documentElement.style.fontSize = ''");
  await setViewport(1280, 900);
  const contrastResults = [];
  for (const theme of ['light', 'dark']) {
    await setValue('#theme-select', theme);
    for (const [id, signal] of [['overwrite', '#numerical-verdict [data-field="passes"]'], ['recompute', '#work-note']]) {
      await runLesson(id);
      const ratios = await evaluate(`(() => {
        const selectors = ['.lede', '.hint', '.note', '#run-button', '#cancel-button', '.capture-col.is-selected .capture-token', '.capture-pos', ${JSON.stringify(signal)}];
        const rgb = color => color.match(/[\\d.]+/g).map(Number);
        const lum = color => { const c=rgb(color).slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
        return selectors.map(selector => {
          const el=document.querySelector(selector); let node=el, bg='rgb(255,255,255)';
          while(node) { const c=getComputedStyle(node).backgroundColor, parts=rgb(c); if(parts.length===3 || parts[3]===1) {bg=c;break;} node=node.parentElement; }
          const a=lum(getComputedStyle(el).color), b=lum(bg);
          return {selector, ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        });
      })()`);
      await expect(ratios.every(r => r.ratio >= 4.5), `contrast ${theme}/${id}: ${JSON.stringify(ratios)}`);
      contrastResults.push({ theme, id, minimum: Math.min(...ratios.map(r => r.ratio)) });
    }
  }
  await runLesson('baseline');
  // The 64-token strip must scroll locally, never move the document during navigation.
  await setValue('#tokens-input', Array.from({length:64},(_,i)=>i%32).join(','));
  const denseBefore = await evaluate('window.__lab.runCount');
  await click('#run-button');
  await waitFor(`window.__lab.runCount === ${denseBefore+1}`);
  await evaluate("document.querySelector('#capture [aria-current]').focus({preventScroll:true})");
  const scrollBefore = await evaluate('scrollY');
  await press('End');
  await expect(await select() === 63, 'dense End did not reach last token');
  await expect(await evaluate('scrollY') === scrollBefore, 'position navigation scrolled whole page');
  await expect(await evaluate("document.querySelector('#capture').scrollLeft > 0"), 'selected column was not scrolled into the local strip');
  await runLesson('baseline');
  await setValue('#theme-select', 'system');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await click('#lang-button');
  return 'real lessons, cancellation, preserved paging/result/focus, local navigation and Ctrl+Enter, translated receipts/ARIA, themes, 390/768/1280 and 200% text verified; contrast ' + JSON.stringify(contrastResults);
}
