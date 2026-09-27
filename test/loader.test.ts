import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPipeline, PipelineError } from '../src/pipeline/loader.js';
import { BUILD_FEATURE, BUILD_FEATURE_FILES, agent, tempDir, writeFiles } from './helpers.js';

function load(files: Record<string, string>) {
  const dir = tempDir();
  writeFiles(dir, files);
  return loadPipeline(path.join(dir, 'pipeline.yaml'), dir);
}

function problems(files: Record<string, string>): string[] {
  try {
    load(files);
    return [];
  } catch (err) {
    if (err instanceof PipelineError) return err.problems;
    throw err;
  }
}

describe('pipeline loader', () => {
  it('compiles the SAD example pipeline', () => {
    const { pipeline, warnings } = load(BUILD_FEATURE_FILES);
    expect(pipeline.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(['step:plan', 'step:code', 'loop:validate-fix', 'gate:review']);
    const loop = pipeline.nodes[2];
    expect(loop.kind === 'loop' && loop.until).toMatchObject({ stepId: 'validate', field: ['verdict'], op: '==', value: 'pass' });
    expect(pipeline.sharedContext[0].content).toContain('todo');
    expect(warnings).toEqual([]);
  });

  it('rejects a loop without max_iterations or with a free-text exit condition', () => {
    const p = problems({
      ...BUILD_FEATURE_FILES,
      'agents/validator.md': agent('validator'),
      'pipeline.yaml': BUILD_FEATURE.replace('max_iterations: 3', ''),
    });
    expect(p.join('\n')).toMatch(/max_iterations/);
    expect(p.join('\n')).toMatch(/must declare output_schema/);
  });

  it('rejects inputs that no earlier step produces', () => {
    const p = problems({ ...BUILD_FEATURE_FILES, 'pipeline.yaml': BUILD_FEATURE.replace('inputs: [plan]\n    output: patch', 'inputs: [findings]\n    output: patch') });
    expect(p).toContain('step "code": input "findings" is not produced by any earlier step');
  });

  it('reports missing files, bad providers and unknown tools together', () => {
    const p = problems({
      ...BUILD_FEATURE_FILES,
      'agents/coder.md': '---\nprovider: gemini\nmodel: x\ntools: [teleport]\n---\nhi',
      'pipeline.yaml': BUILD_FEATURE.replace('agents/planner.md', 'agents/nope.md'),
    });
    expect(p.join('\n')).toMatch(/agent file not found: agents\/nope.md/);
    expect(p.join('\n')).toMatch(/"provider" must be one of openai, cursor/);
    expect(p.join('\n')).toMatch(/unknown tool "teleport"/);
  });

  it('warns when steps that could share a cache run on different models', () => {
    const { warnings } = load({ ...BUILD_FEATURE_FILES, 'agents/coder.md': '---\nprovider: openai\nmodel: m2\n---\nROLE: coder' });
    expect(warnings.join('\n')).toMatch(/"plan" \(openai\/m1\) and "code" \(openai\/m2\)/);
  });

  it('gives a stable hash for the same content', () => {
    expect(load(BUILD_FEATURE_FILES).pipeline.hash).toBe(load(BUILD_FEATURE_FILES).pipeline.hash);
  });
});
