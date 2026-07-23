import { expect, test } from 'vitest'
import { checkAbiCoverage, parseEngineAbi } from '../../scripts/checkAbiCoverage'

test('every schema boundary field is carried by the engine or explicitly waived', () => {
  const { ok, errors } = checkAbiCoverage()
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})

test('engine ABI parser extracts the param table and hotframe length', () => {
  const abi = parseEngineAbi(`
    constexpr const char* kParamNames[] = { "a", "b" };
    constexpr uint32_t kHotFrameLength = 5;
  `)
  expect(abi.params).toEqual(['a', 'b'])
  expect(abi.hotFrameLength).toBe(5)
})

test('parser throws loudly when the engine table cannot be found', () => {
  expect(() => parseEngineAbi('constexpr uint32_t kHotFrameLength = 3;')).toThrow(/kParamNames/)
  expect(() => parseEngineAbi('kParamNames[] = { "a" }')).toThrow(/kHotFrameLength/)
})
