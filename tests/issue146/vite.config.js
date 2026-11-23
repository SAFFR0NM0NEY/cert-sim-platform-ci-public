import {mergeConfig,defineConfig} from 'vite';
import path from 'node:path';
import base from '../../vite.config.js';
export default defineConfig(env=>mergeConfig(base(env),{resolve:{alias:[
  {find:/(?:^|.*\/)hooks\/useStudentProgress\.js$/,replacement:path.resolve('tests/issue146/learner.js')},
  {find:/(?:^|.*\/)hooks\/useTrainerStudentDetail\.js$/,replacement:path.resolve('tests/issue146/trainer.js')},
]}}));
