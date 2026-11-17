import { readFile } from 'node:fs/promises'
import { executeTool } from '../calendar/index.mjs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const CALENDAR_TOOLS = new Set(['calendar_find_slots', 'calendar_prepare_booking', 'calendar_confirm_booking', 'calendar_booking_status'])
export { connectionInfo as calendarConnection } from '../calendar/index.mjs'

/** The peer identity is captured by the server, never accepted from model arguments. */
export function calendarTools(file: string, peer: string, connectionId: string): ToolDefinition[] {
  const schemas: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
    calendar_find_slots: { description: 'Find available meeting times. Check only the authorized calendar; never expose other event details. Apply owner scheduling instructions and clarify timezone first.',
      properties: { start: { type: 'string', description: 'ISO timestamp with timezone offset' }, end: { type: 'string' }, durationMinutes: { type: 'integer', minimum: 15, maximum: 180 } }, required: ['start', 'end', 'durationMinutes'] },
    calendar_prepare_booking: { description: 'Prepare an expiring proposal without creating an event. Present the returned bookingId, exact date, timezone, time and title to the visitor for confirmation.',
      properties: { start: { type: 'string' }, end: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai' }, title: { type: 'string', maxLength: 128 }, description: { type: 'string', maxLength: 700 } }, required: ['start', 'end', 'timezone', 'title'] },
    calendar_confirm_booking: { description: 'Create the previously proposed event only after this visitor explicitly confirms its exact details. Reuse the same bookingId after any interruption; never create a replacement to retry an uncertain write.',
      properties: { bookingId: { type: 'string' }, confirmed: { type: 'boolean', const: true } }, required: ['bookingId', 'confirmed'] },
    calendar_booking_status: { description: 'Check this visitor’s booking after timeout/disconnection. Uncertain means not yet verified, never permission to create again.',
      properties: { bookingId: { type: 'string' } }, required: ['bookingId'] },
  }
  return Object.entries(schemas).map(([name, schema]) => ({ name, description: schema.description,
    parameters: { type: 'object', properties: schema.properties, required: schema.required, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, { signal }) => {
      return executeTool(file, connectionId, peer, name, args, { signal })
    },
  }))
}

export const calendarSkill = (): Promise<string> => readFile(new URL('../skills/meeting-booking/SKILL.md', import.meta.url), 'utf8')
