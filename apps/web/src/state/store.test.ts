import { describe, expect, it, vi } from 'vitest'
import { applyEvent, reducer } from './store'
import type { AgentTask, PlotPlan } from '../types'

vi.mock('../client/realAgentClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../client/realAgentClient')>(),
  readConfigFromLocation: () => ({ enabled: true, baseUrl: 'http://127.0.0.1', token: '', engine: 'python' })
}))

describe('source revision event synchronization', () => {
  it('updates the editing baseline and replaces the matching revision without losing other history', () => {
    const task: AgentTask = {
      taskId: 'task_test', title: 'data.csv', createdAt: 1, state: 'PRESENT', steps: [], evidence: [],
      plans: [], preferences: [], retries: 0, currentRevision: 1,
      execution: { version: 1, engine: 'python', status: 'success', logs: [] },
      planVersions: [{ version: 1, reason: 'initial', plans: [] }]
    }
    const plan = { plan_id: 'edited_plan' } as PlotPlan
    const revision = { version: 2, parent: 1, reason: 'source', plans: [plan] }
    const updated = applyEvent(task, { type: 'revision_applied', revision })
    expect(updated.currentRevision).toBe(2)
    expect(updated.plans).toEqual([plan])
    expect(updated.planVersions?.map((item) => item.version)).toEqual([1, 2])
    expect(applyEvent(updated, { type: 'revision_applied', revision }).planVersions).toHaveLength(2)
    expect(task.currentRevision).toBe(1)
  })
})


describe('task list synchronization', () => {
  it('ignores a late task list response from a different project', () => {
    const state = { currentProjectId: 'new-project', projectTasks: [] } as any
    expect(reducer(state, { kind: 'project_tasks_loaded', projectId: 'old-project', tasks: [{ taskId: 'old' }] as any })).toBe(state)
  })
  it('updates the current task summary when execution changes state', () => {
    const task = { taskId: 'task', state: 'INGEST', execution: { status: 'idle', logs: [] }, plans: [], preferences: [], evidence: [], steps: [] } as any
    const state = { task, projectTasks: [{ taskId: 'task', state: 'INGEST' }], globalPreferences: [] } as any
    const result = reducer(state, { kind: 'event', taskId: 'task', title: 'task', event: { type: 'state_delta', state: 'FAILED' } })
    expect(result.projectTasks[0].state).toBe('FAILED')
  })
})
