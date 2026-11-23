import {test,expect} from '@playwright/test';
for(const width of [1440,390,320])for(const scale of ['100%','200%']){
  test(`truthful non-startable draft ${width}px ${scale}`,async({page})=>{
    await page.setViewportSize({width,height:1000});const posts=[];
    page.on('request',r=>{if(r.method()==='POST')posts.push(r.url())});
    await page.route('https://**/*',r=>r.abort());
    await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&exam=serverplussk0005');
    await page.evaluate(s=>document.documentElement.style.fontSize=s,scale);
    const preview=page.getByRole('region',{name:'Unpublished profile preview'});
    await expect(preview).toContainText('Full Simulation');await expect(preview).toContainText('60 questions');await expect(preview).toContainText('90 minutes');
    await expect(preview).toContainText('Compact Simulation');await expect(preview).toContainText('25 questions');await expect(preview).toContainText('40 minutes');
    await expect(preview.getByText(/2 distinct variants/)).toHaveCount(2);
    await expect(preview).toContainText('700/1000');await expect(preview).toContainText('750');
    await expect(preview).toContainText('Interactive PBQs are not currently included');
    await expect(page.getByRole('button',{name:/Start (exam|practice)|Study Sandbox|Targeted Domain/})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(posts).toEqual([]);
    if(scale==='200%') await page.screenshot({path:test.info().outputPath(`preview-${width}.png`),fullPage:true});
  });
  test(`generic command whitespace and selection ${width}px ${scale}`,async({page})=>{
    await page.setViewportSize({width,height:1000});
    await page.goto('/tests/r3g/inf301-code-wrap-harness.html?exam=serverplussk0005&multi=true');
    await page.evaluate(s=>document.documentElement.style.fontSize=s,scale);
    await expect(page.locator('.exam-header .eyebrow')).toHaveText('SK0-005');
    const code=page.locator('.question-card h3 .supplied-multiline-text');
    await expect(code).toHaveCSS('white-space','pre');await expect(code).toHaveCSS('font-weight','400');
    expect(await code.textContent()).toBe(await page.evaluate(()=>window.sourceFixture.snippet));
    await code.focus();await expect(code).toBeFocused();await page.keyboard.press('ArrowRight');
    await page.locator('.option-row input').first().check();
    expect(await page.evaluate(()=>Object.values(window.fixtureAnswers)[0])).toHaveLength(1);
    await page.getByRole('button',{name:'Save fixture'}).click();
    expect(await page.evaluate(()=>window.fixtureSaved)).toEqual(await page.evaluate(()=>window.fixtureAnswers));
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('.exam-header *, .mobile-exam-tools, .question-area')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,classes:e.className,right:e.getBoundingClientRect().right}))}));
    expect(layout.scroll,JSON.stringify(layout)).toBeLessThanOrEqual(layout.width+1);
  });
}
test('library/direct routes remain non-startable even with draft access',async({page},info)=>{
  const posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.url())});await page.route('https://**/*',r=>r.abort());
  await page.goto('/exams');await page.getByLabel('Search exams').fill('SK0-005');
  if(info.project.name==='draft'){
    await page.getByRole('button',{name:/SK0-005.*Server\+/i}).click();
    await expect(page).toHaveURL('/exams/server-plus');
    await expect(page.getByRole('region',{name:'Unpublished profile preview'})).toBeVisible();
  }else await expect(page.getByRole('button',{name:/SK0-005.*Server\+/i})).toHaveCount(0);
  for(const path of ['/exams/server-plus/full','/exams/server-plus/compact','/exams/server-plus/study','/exams/server-plus/targeted','/exams/server-plus/unknown']){
    await page.goto(path);await expect(page.getByRole('button',{name:'Start exam',exact:true})).toHaveCount(0);
  }
  expect(posts).toEqual([]);
});
test('source-preview runner refuses before contacting Edge',async({page})=>{
  const calls=[];page.on('request',r=>{if(r.url().includes('/functions/v1/'))calls.push(r.method())});
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?exam=serverplussk0005');
  await expect(page.getByText('Unpublished source preview. New starts are unavailable.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Start exam',exact:true})).toHaveCount(0);expect(calls).toEqual([]);
});

test('browser metadata selects final draft without inventing publication',async({page})=>{
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&exam=serverplussk0005');
  const facts=await page.evaluate(async()=>{const m=await import('/src/exams/protectedProfileMetadata.js');return{candidate:m.getDraftProtectedProfileMetadata('serverplussk0005').candidateVersion,published:m.getProtectedDashboardMetadata('serverplussk0005')};});
  expect(facts).toEqual({candidate:'1.0.0',published:null});
  await expect(page.getByRole('region',{name:'Unpublished profile preview'})).toBeVisible();
});
