import React from 'react';
import {createRoot} from 'react-dom/client';
import StudentProgressPage from '../../src/components/account/StudentProgressPage.jsx';
import TrainerStudentDetailPage from '../../src/components/trainer/TrainerStudentDetailPage.jsx';
import '../../src/styles/global.css';
const staff=new URLSearchParams(location.search).get('view')==='staff';
createRoot(document.getElementById('root')).render(staff?<TrainerStudentDetailPage/>:<StudentProgressPage/>);
