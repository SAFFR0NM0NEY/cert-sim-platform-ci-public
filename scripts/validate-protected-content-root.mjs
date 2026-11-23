import {
  buildPublicationRequestInMemory,
  createExternalPackageSummary,
  loadExternalProtectedPackage,
} from './backend-exam-publication/external-content-package.mjs';

const rootArgument = process.argv.find((value) => value.startsWith('--content-root='));
const contentRoot = rootArgument?.slice('--content-root='.length) ?? process.env.CERTSIM_PROTECTED_CONTENT_ROOT;
const examArgument = process.argv.find((value) => value.startsWith('--exam-key='));
const examKey = examArgument?.slice('--exam-key='.length) ?? process.env.CERTSIM_PROTECTED_EXAM_KEY;
const loaded = await loadExternalProtectedPackage(contentRoot, { examKey });
if (process.argv.includes('--build-request-in-memory')) buildPublicationRequestInMemory(loaded);
console.log(JSON.stringify(createExternalPackageSummary(loaded)));
