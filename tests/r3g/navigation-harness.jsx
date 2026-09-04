import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Header from '../../src/components/layout/Header.jsx';
import { requestProtectedNavigation } from '../../src/lib/protectedNavigationGuard.js';
import '../../src/styles/global.css';
function Harness() {
  const [destination, setDestination] = useState('runner');
  const recorder = window.__navigationRecorder ??= { saves: [], navigations: [], submits: 0, starts: 0, failNext: false };
  async function navigate(next) { return requestProtectedNavigation({ isProtectedAttempt:true, saveCurrentResponse:async()=>{ recorder.saves.push(next); if(recorder.failNext){recorder.failNext=false;return false;} return true; }, navigate:()=>{recorder.navigations.push(next);setDestination(next);} }); }
  useEffect(()=>{ const pop=()=>navigate('browser history'); window.addEventListener('popstate',pop); return()=>window.removeEventListener('popstate',pop); },[]);
  window.__failNextNavigation = () => { recorder.failNext = true; };
  return <><Header onOpenHome={()=>navigate('Home')} onOpenBrowseExams={()=>navigate('Browse Exams')} onOpenAccount={()=>navigate('Account')} onOpenPrivacy={()=>navigate('Privacy')} onOpenTerms={()=>navigate('Terms')} /><main><h1>{destination}</h1></main></>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
