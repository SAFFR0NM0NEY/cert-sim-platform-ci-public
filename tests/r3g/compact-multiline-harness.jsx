import React from 'react';
import {createRoot} from 'react-dom/client';
import QuestionCard from '../../src/components/exam/QuestionCard.jsx';
import {multilineMatchingQuestion} from '../../scripts/fixtures/multiline-matching.mjs';
import '../../src/styles/global.css';
const query=new URLSearchParams(location.search),question=multilineMatchingQuestion(query.get('reuse')==='true');
if(query.get('ordinary')==='true')question.targets=question.targets.map((t,i)=>({...t,text:'Synthetic single-line target '+(i+1)}));
function Harness(){const[answer,setAnswer]=React.useState({});window.__matchingAnswer=answer;window.__matchingFixture=question;return <main className="exam-workspace" style={{maxWidth:900,margin:'20px auto'}}><QuestionCard question={question} answer={answer} onAnswerChange={(_id,value)=>setAnswer(value)}/><button onClick={()=>document.getElementById('navigation-proof').textContent='Navigation works'}>Next fixture</button><p id="navigation-proof"/></main>;}
createRoot(document.getElementById('root')).render(<Harness/>);
