import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = [
  'src/App.jsx',
  'src/components/account/AccountPage.jsx',
  'src/components/account/StudentProgressPage.jsx',
  'src/components/auth/AuthPanel.jsx',
  'src/components/exam/Home.jsx',
  'src/components/legal/LegalPage.jsx',
  'src/protected/ProtectedSavedResultsPage.jsx',
].map(read).join('\n');

for (const prohibited of [
  'Certification exams remain available without signing in',
  'Optional account access. Exams remain available without signing in.',
  'Content-free result summary',
  'Protected account results',
  'My Progress / Readiness',
  'Staff/Admin tools',
  'Not saved to Attempt History.',
  'reveal explanations while studying',
]) {
  if (source.includes(prohibited)) throw new Error(`stale UI copy remains: ${prohibited}`);
}

const savedResults = read('src/protected/ProtectedSavedResultsPage.jsx');
if (!savedResults.includes('if (!client) return')) throw new Error('signed-out Saved Results must resolve before history/practice presentation');
if (!savedResults.includes('Sign in to view Saved Results')) throw new Error('signed-out Saved Results needs a clear sign-in state');
if (!savedResults.includes('getExamDisplayName(item.examKey)')) throw new Error('learner history must use a display name instead of a raw exam key');
if (savedResults.includes('{item.examKey} {item.packageVersion}')) throw new Error('raw package identity remains learner-visible');
if (savedResults.includes("value.profile?.name || value.profile?.key")) throw new Error('raw profile identity remains learner-visible');

const home = read('src/components/exam/Home.jsx');
if (!home.includes('Practice appears in Saved Results but does not')) throw new Error('protected practice history/readiness distinction is missing');
if (!home.includes('<h3>Practice overview</h3>')) throw new Error('duplicate selected-exam title was not replaced');

console.log(JSON.stringify({ ok: true, issue: 38, signedOutHistoryActionable: false, rawLearnerIdsVisible: false }));
