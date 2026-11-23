import { buildStudentProgressSnapshot } from '../../src/lib/studentProgressService.js';
const row = (examKey,packageVersion,domainId,percentage) => ({attemptId:`fixture-${examKey}`,examKey,packageVersion,purpose:'self_directed_exam',profileKey:'full',scaledScore:680,rawPercentage:63,passed:false,submittedAt:'2026-01-02T12:00:00Z',domainBreakdown:{items:[{domainId,domainLabel:domainId,percentage,earnedPoints:5,maxPoints:8}]}});
export const results=[row('az204','1.0.0','develop-azure-compute-solutions',63),row('inf303','1.1.0','domain-1',55),row('ai901','3.0.0','ai-agents',74)];
results[1].domainBreakdown.items.push({...results[1].domainBreakdown.items[0],domainId:'domain-2',domainLabel:'domain-2'});
const snapshot=buildStudentProgressSnapshot({rawResults:results});
export function learner(){return {...snapshot,isSupabaseConfigured:true,isAuthenticated:true,loading:false,refreshProgress:()=>{}};}
export function trainer(){return {isSupabaseConfigured:true,isAuthenticated:true,isPlatformOwner:true,memberships:[],student:{displayName:'Synthetic test learner'},assignments:[],assignmentReadiness:[],examProgress:snapshot.examProgress,results,selectedResult:results[1],history:{totalCount:3},refresh:()=>{},clearSelectedResult:()=>{},loadResultDetail:()=>{},loading:false};}
