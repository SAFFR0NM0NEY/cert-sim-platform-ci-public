import assert from 'node:assert/strict';
import fs from 'node:fs';

const workspace = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewWorkspace.jsx', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
const savedResults = fs.readFileSync(new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const browser = fs.readFileSync(new URL('../tests/r3g/issue118-released-review.spec.js', import.meta.url), 'utf8');

assert.match(workspace, /import ReleasedReviewAnswer/);
assert.match(workspace, /import ReleasedExecutablePythonReview/);
assert.match(workspace, /<ReleasedReviewAnswer presentation=\{item\.presentation\} questionType=\{item\.questionType\} value=\{item\.response\}/);
assert.match(workspace, /<ReleasedExecutablePythonReview item=\{item\}/);
assert.match(workspace, /aria-current=\{index === boundedIndex \? 'step'/);
assert.match(workspace, /onKeyDown=\{\(event\) => handlePaletteKeyDown/);
assert.match(workspace, />Previous<\/button>/);
assert.match(workspace, />Next<\/button>/);
assert.match(workspace, /Question \{position\} of \{items\.length\}/);
assert.match(workspace, /isInformationalItem\(item\)/);
assert.match(workspace, /This is contextual material and is not a scored response/);
assert.doesNotMatch(workspace, /\{item\.questionId\}/);
assert.doesNotMatch(workspace, /\{item\.itemId\}/);
assert.doesNotMatch(workspace, /JSON\.stringify/);
assert.doesNotMatch(workspace, /setResponse|saveResponse|submit|regrade/);

assert.match(runner, /import ReleasedReviewWorkspace/);
assert.match(runner, /if \(review\) return <ReleasedReviewWorkspace review=\{review\}/);
assert.match(runner, /const reviewReleased = result\?\.reviewStatus === 'released'/);
assert.match(runner, /reviewReleased && <button[^>]+>View released review/);
assert.doesNotMatch(runner, /protected-review-list/);

assert.match(savedResults, /import ReleasedReviewWorkspace/);
assert.match(savedResults, /value\.reviewStatus === 'released' \? <button[\s\S]+?'View released review'/);
assert.match(savedResults, /client\.getReview\(attemptId, \{ signal: controller\.signal \}\)/);
assert.match(savedResults, /releasedReview\.open && releasedReview\.value/);
assert.match(savedResults, /<ReleasedReviewWorkspace review=\{releasedReview\.value\}/);

assert.match(styles, /\.released-review-palette\s*\{[^}]*max-height: 224px;[^}]*overflow-y: auto;/s);
assert.match(styles, /\.released-review-layout\s*\{[^}]*grid-template-columns:/s);
assert.match(styles, /\.released-review-palette-button\.current/);
assert.match(browser, /toHaveCount\(90\)/);
assert.match(browser, /getReviewAttemptIds/);
assert.match(browser, /Answer details unavailable/);
assert.match(browser, /mutations\)\)\.toBe\(0\)/);

console.log('Issue #118 shared released-review workspace validation passed.');
