// Vercel serverless entry: one Express app per function instance.
import { createRuntime } from '../src/bootstrap.js';

const { app } = createRuntime();

export default app;
