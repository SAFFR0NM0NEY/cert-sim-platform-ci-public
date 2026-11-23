import React from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../../src/components/exam/Home.jsx';
import ProtectedExamRunner from '../../src/components/exam/ProtectedExamRunner.jsx';
import ProtectedSavedResultsPage from '../../src/protected/ProtectedSavedResultsPage.jsx';
import { examRegistry, inf303ExamDefinition } from '../../src/exams/examRegistry.protected.js';
import '../../src/styles/global.css';
const q=new URLSearchParams(location.search), definition=examRegistry.find(e=>e.id===q.get('exam'))??inf303ExamDefinition;
const exam={...definition,...definition.ui,name:definition.title,domains:definition.domainNames};
// Models the content-free projection coordinated with a future release, never publication.
if(q.get('future')==='true'){
  exam.protectedPackageVersion='1.3.0';
  exam.strictBetaProfiles=exam.strictBetaProfiles.map(p=>p.id==='inf303-standard'
    ? {...p,totalScoredQuestions:36,standardQuestionCount:36,timeLimitMinutes:45,countPolicy:{allowedCounts:[34,36]}} : {...p,timeLimitMinutes:25});
}
const profile=exam.strictBetaProfiles.find(p=>p.id===q.get('profile'))??exam.strictBetaProfiles[0];
const session={access_token:'synthetic-mode-token',user:{id:'21400000-0000-4000-8000-000000000001'}};
const view=q.get('view');
createRoot(document.getElementById('root')).render(view==='dashboard'
  ? <Home session={q.get('signedOut')==='true' ? null : session} exam={exam} view="dashboard" onStartDraftStrictBeta={()=>{}} />
  : view==='history' ? <ProtectedSavedResultsPage session={session} attemptId={q.get('attempt')??''} onReturnHome={()=>{}} />
  : <ProtectedExamRunner examConfig={exam} profile={profile} session={session} selectedMode={exam.strictBetaMode} student={{name:'Synthetic learner'}}
      practiceRequest={{purpose:'self_directed_exam',includePbqs:false,mixStrategy:'balanced'}} onExit={()=>{}} />);
