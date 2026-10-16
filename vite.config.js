import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DELIVERY_MODES = new Set(['maintenance', 'protected']);

export default defineConfig(() => {
  const requestedMode = String(
    process.env.VITE_CERTSIM_EXAM_DELIVERY_MODE ?? 'protected',
  ).trim().toLowerCase();
  const deliveryMode = DELIVERY_MODES.has(requestedMode) ? requestedMode : 'protected';
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const maintenanceApp = path.resolve(sourceRoot, 'maintenance/MaintenanceApp.jsx');
  const maintenanceStyles = path.resolve(sourceRoot, 'maintenance/maintenance.css');
  const safeSurface = path.resolve(sourceRoot, 'protected/LegacyFeatureUnavailable.jsx');
  const protectedResults = path.resolve(sourceRoot, 'protected/ProtectedSavedResultsPage.jsx');
  const protectedReportExport = path.resolve(sourceRoot, 'protected/protectedReportPdfExport.js');
  const aliases = [
    ...(deliveryMode === 'maintenance' ? [
      { find: './App.jsx', replacement: maintenanceApp },
      { find: './styles/global.css', replacement: maintenanceStyles },
    ] : []),
    { find: './components/results/SavedResultsPage.jsx', replacement: protectedResults },
    { find: '../results/SavedResultsPage.jsx', replacement: protectedResults },
    { find: /(?:^|.*[\\/])utils[\\/]reportPdfExport\.js$/, replacement: protectedReportExport },
    { find: /(?:^|.*[\\/])exams[\\/]examRegistry\.js$/, replacement: path.resolve(sourceRoot, 'exams/examRegistry.protected.js') },
    { find: /(?:^|.*[\\/])components[\\/]exam[\\/](CaseStudyPractice|ExamRunner|ExamResults|ExamReview|StudySandbox|TargetedPractice)\.jsx$/, replacement: safeSurface },
    { find: /(?:^|.*[\\/])components[\\/]pbq[\\/]PBQRenderer\.jsx$/, replacement: safeSurface },
    { find: /(?:^|.*[\\/])components[\\/]results[\\/]SavedResultsPage\.jsx$/, replacement: protectedResults },
    { find: /(?:^|.*[\\/])utils[\\/](weakAreaPractice|generateExamAttempt|generateAz400SectionedAttempt|generateSecurityPlusStrictBetaAttempt|validateQuestionBank)\.js$/, replacement: safeSurface },
  ];

  return {
    define: {
      __CERTSIM_BUILD_DELIVERY_MODE__: JSON.stringify(deliveryMode),
    },
    plugins: [react(), forbidProtectedContentPlugin({ deliveryMode, sourceRoot })],
    resolve: { alias: aliases },
    build: { sourcemap: false },
  };
});

function forbidProtectedContentPlugin({ deliveryMode, sourceRoot }) {
  const contentPatterns = [
    /[\\/]exams[\\/].*[\\/]questions[\\/]/i,
    /[\\/]exams[\\/].*questionbank\.[cm]?[jt]sx?$/i,
    /[\\/]exams[\\/].*(pbqdemolabs|pbqs|casestudies)\.[cm]?[jt]sx?$/i,
    /[\\/]utils[\\/](scoring|pbqscoring|feedbackhelpers|reviewhelpers|answercomparison)\.[cm]?[jt]sx?$/i,
  ];
  return {
    name: 'certsim-protected-content-boundary',
    enforce: 'post',
    load(id) {
      const cleanId = id.split('?')[0];
      if (cleanId.startsWith(sourceRoot) && contentPatterns.some((pattern) => pattern.test(cleanId))) {
        this.error(`Protected build loaded a legacy content dependency: ${path.relative(sourceRoot, cleanId)}`);
      }
      return null;
    },
    resolveId(source, importer) {
      if (!importer) return null;
      const resolved = path.resolve(path.dirname(importer), source.split('?')[0]);
      if (resolved.startsWith(sourceRoot) && contentPatterns.some((pattern) => pattern.test(resolved))) {
        this.error(`Protected build blocked a legacy content dependency: ${path.relative(sourceRoot, resolved)} imported by ${path.relative(sourceRoot, importer)}`);
      }
      return null;
    },
  };
}
