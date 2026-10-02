# Calendar blocks

The calendar displays a full local day, from 00:00 through 24:00. It opens near the salon's working day and can be scrolled to either midnight boundary. Empty-slot selection uses quarter-hour starts; appointment, block and note movement snaps to five minutes.

## Use

Choose **Add blocked time** from a calendar slot. The form retains that slot's date, time and therapist or room. A room slot defaults to all tables; choose a specific table in the form when needed. Set the title, optional note and duration, then save. Click a grey card to view it, edit it or remove it. This does not require a treatment or client record.

Drag a grey card with the mouse to move its time or resource in five-minute steps. On touch, hold the card until it is selected, lift your finger, then drag the selected card. Use **Save** to keep a touch move or **Cancel** to restore the original. ArrowUp/ArrowDown adjust five minutes while the selected card or move footer has keyboard focus, and **Move calendar entry** in the details opens the same move controls without a long press. A normal click or tap still opens the details. The title, note, duration and **Block availability** setting are preserved.

The compact move bar shows only **Cancel** and **Save**. Time remains visible on the moving card; destination and table scope are announced to screen readers. A therapist destination has no table; a whole-room block stays whole-room when moved to another room. A specific table is preserved if available in the destination room; Table 2 maps to Table 1 in a single-table room. Moving from a therapist to a room selects all tables. Moves that change resource type or table scope require an explicit **Save** even with a mouse. Once such a drop opens the confirmation controls, later adjustments stay unsaved until Save or Cancel; returning to the original position writes nothing. Conflicting saves keep the draft available for correction.

**Block availability** reserves the selected resource for the full interval. Turn it off for a call reminder or other note that should not prevent a booking. Note-only entries can overlap appointments and other notes. A room entry can cover one table or all tables; a therapist entry reserves only that therapist.

Each room occupies one calendar column regardless of table count. A lone card fills that column, and entries whose times overlap appear side by side. A whole-room block appears once. These visual lanes do not change physical table assignments or room capacity.

Blocks and notes may be placed outside working hours. The expanded display does not change therapist working hours or the existing appointment booking rules. Midnight is represented as 00:00 at the start and 24:00 at the end of a day; an entry must finish within its selected date. Use separate entries for an interval spanning two dates.

Blocks are separate records, not zero-price appointments. They do not contribute to massage counts, hours, revenue, client visit history or therapist bonuses.

## Access and persistence

Owners and reception staff can create, view, edit and remove blocks. Therapists see the time, resource and whether the entry reserves availability, with a generic label. Free-text titles and notes are excluded from therapist API responses because they can contain client details.

The server checks overlaps in both directions: a blocking entry cannot cover an existing appointment, and an appointment cannot take a blocked therapist or table. Another table in the same room remains available when only one table is blocked. Updates and removal require the current record version. Conflicting changes do not overwrite another user's work. Changes are recorded in the audit log.

The additive `0011_calendar_blocks.sql` migration is also initialized by authenticated application requests. It does not replace appointment tables or rewrite historical bookings.

## API

| Operation         | Route                                                    | Result         |
| ----------------- | -------------------------------------------------------- | -------------- |
| Read a date range | `GET /api/calendar-blocks?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ blocks }`   |
| Create            | `POST /api/calendar-blocks`                              | `{ block }`    |
| Update            | `PUT /api/calendar-blocks/:id`                           | `{ block }`    |
| Remove            | `DELETE /api/calendar-blocks/:id` with `{ version }`     | `{ ok: true }` |

`GET /api/appointments` also returns a separate `blocks` array for the requested date range. Block fields are `id`, `date`, `start`, `duration`, `resourceType`, `resourceId`, `bed` and `blocksAvailability`. Authorized staff also receive `version`, the free-text fields `title` and `note`, and creation/update timestamps. Times are minutes since local midnight, in five-minute steps. A room `bed` of `null` covers all tables; therapist blocks use `null`.

Writes require an authenticated owner/reception session, the application origin and a valid CSRF token. Calendar fixtures and browser test notes are fictional; development checks do not seed the hosted salon database.
