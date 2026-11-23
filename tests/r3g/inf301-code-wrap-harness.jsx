import React from 'react';
import {createRoot} from 'react-dom/client';
import ExamWorkspacePresentation from '../../src/components/exam/ExamWorkspacePresentation.jsx';
import {toPresentationQuestion} from '../../src/lib/protectedExamContract.js';
import '../../src/styles/global.css';
import {getExamDisplayMetadata} from '../../src/exams/examDisplayMetadata.js';

// Original synthetic markup only. No protected content, answers or scoring.
const markupSnippet = 'Inspect this supplied HTML/CSS:\n<section class="demo">\n\t<div data-description="' + 'long attribute value '.repeat(20) + '">\n    <span>Alpha  beta</span>\n\t</div>\n</section>\n.demo {\n    display: grid;\n\tgrid-template-columns: repeat(2, minmax(0, 1fr));\n}\n/* ' + 'LongUnbrokenSyntheticToken'.repeat(24) + ' */';
const markupCompact = '<section data-label="' + 'single line unchanged '.repeat(18) + '"><span>Keep  spaces</span></section>';
const fixture=new URLSearchParams(location.search),examKey=fixture.get('exam')??'inf301';
// Original synthetic diagnostics; not an exam-bank question or answer key.
const snippet=examKey==='serverplussk0005'
  ? 'Supplied synthetic maintenance log:\n  09:00  volume=demo  state=online\n\t09:01  retry_count=2  status=waiting\n  Get-Volume -FileSystemLabel Demo\n  path=' + 'SyntheticLongDiagnosticSegment'.repeat(24) + '\n    Keep  spaces and indentation.'
  : markupSnippet;
const compact=examKey==='serverplussk0005'
  ? 'Inspect supplied config: retry_limit=3; log_path=' + 'SyntheticLongPathSegment'.repeat(22)
  : markupCompact;
const item={itemId:'synthetic-source',questionType:fixture.get('multi')==='true'?'multi-select':'single-choice',presentation:{question:snippet,selectionLimit:2,options:[{id:'one',text:compact},{id:'two',text:'Choose an alternative.\n\tPreserve  spaces.'},{id:'three',text:'color: rebeccapurple;'},{id:'four',text:'Ordinary readable prose.'}]}};
const question=toPresentationQuestion(item);
window.sourceFixture={snippet,compact,question};
function Harness(){const[answers,setAnswers]=React.useState({});window.fixtureAnswers=answers;return <main style={{maxWidth:1200,margin:'auto',padding:8}}><ExamWorkspacePresentation exam={{id:examKey,code:getExamDisplayMetadata(examKey)?.code??examKey.toUpperCase(),name:'Synthetic presentation',packageVersion:'1.0.0',durationMinutes:50,deliveryMode:'protected',profile:{name:'Full Simulation',totalScoredQuestions:35,timeLimitMinutes:50}}} navigatorQuestions={[question]} normalQuestions={[question]} pbqQuestions={[]} caseStudyBlocks={[]} currentIndex={0} currentSection="standard" answers={answers} flaggedQuestionIds={[]} scoredAnswerSummary="0 of 1 answered" questionStateById={{}} onAnswerChange={(id,value)=>setAnswers(v=>({...v,[id]:value}))} onNavigate={()=>{}} onToggleFullscreen={()=>{}} onOpenQuestionMap={()=>{}} onCloseQuestionMap={()=>{}} onExit={()=>{}} exitLabel="Save and exit" timerRemainingSecondsSource={()=>3000} onTimeExpired={()=>{}} actionControls={<button type="button" onClick={()=>window.fixtureSaved=structuredClone(answers)}>Save fixture</button>}/></main>}
createRoot(document.getElementById('root')).render(<Harness/>);
