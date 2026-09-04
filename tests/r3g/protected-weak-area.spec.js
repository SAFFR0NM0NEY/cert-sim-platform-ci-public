import { expect, test } from '@playwright/test';

test('legacy-only weak evidence falls back to a current profile and enables protected start', async ({ page }) => {
  const availabilityRequests=[];
  const legacyResult={
    attemptId:'legacy-fixture',examKey:'az400',packageVersion:null,profileKey:'retired-profile',
    purpose:'self_directed_exam',completedAt:'2026-08-01T00:00:00.000Z',score:550,percentage:55,
    passed:false,domainSummary:{'domain-x':{label:'Domain X',earnedPoints:55,maxPoints:100,percentage:55}},
    serverAuthoritative:false,reviewStatus:'withheld',source:'legacy_authoritative',
  };
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const url=new URL(route.request().url()); const path=url.pathname.split('/certsim-protected-exam')[1];
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/history')) return json({items:[legacyResult],returnedCount:1,totalCount:1,remainingCount:0,nextCursor:null});
    if(path.startsWith('/practice/availability')) {
      availabilityRequests.push(Object.fromEntries(url.searchParams));
      return json({examKey:'az400',packageVersion:'1.0.0',profileKey:url.searchParams.get('profileId'),purpose:'weak_area',selectedCount:10,available:20,adjustedCount:false});
    }
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-saved-results-harness.html');
  await expect(page.getByLabel('Practice profile')).toHaveValue('az400-mvp-compact-profile');
  await expect(page.getByLabel('Weak domain')).toHaveValue('domain-x');
  await expect(page.getByRole('button',{name:'Start Weak Area Practice'})).toBeEnabled();
  expect(availabilityRequests.at(-1)).toMatchObject({examKey:'az400',profileId:'az400-mvp-compact-profile',purpose:'weak_area',domain:'domain-x'});
  await page.getByRole('button',{name:'Start Weak Area Practice'}).click();
  await expect(page.getByTestId('started')).toContainText('az400-mvp-compact-profile');
});
