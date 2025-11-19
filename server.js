/* 
 * Tickly Slack Time Tracking Bot
 *
 * This server implements a basic time‑tracking bot for Slack using the Bolt framework
 * and stores data in Supabase. It supports commands and interactive buttons to start
 * and stop timers, add notes, create manual time entries, and assign projects.
 *
 * To run this server locally:
 *   1. Create a `.env` file in the project root with the following variables:
 *      SLACK_SIGNING_SECRET=your-slack-signing-secret
 *      SLACK_BOT_TOKEN=your-bot-token (starts with xoxb-)
 *      SUPABASE_URL=https://<your-project-id>.supabase.co
 *      SUPABASE_ANON_KEY=your-anon-key
 *      SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 *   2. Install dependencies: npm install @slack/bolt express dotenv @supabase/supabase-js
 *   3. Start the server: node tickly_server.js
 *
 * Make sure your Slack app’s Event Subscriptions and Interactivity settings point to:
 *   https://<public-host>/slack/events  (for events)
 *   https://<public-host>/slack/interact (for interactive actions)
 * where <public-host> is your ngrok or production URL.
 */

const { App, ExpressReceiver } = require('@slack/bolt');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialise Supabase client using the service role key so the server can read and write
// time entries. NEVER expose the service role key to the client or front‑end.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Set up an ExpressReceiver to customise endpoint paths. Slack will send events to
// /slack/events and interactive payloads to /slack/interact. The Bolt app uses this
// receiver internally instead of starting its own HTTP server.
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    events: '/slack/events',
    actions: '/slack/interact'
  }
});

// Create the Bolt app. We don’t enable socket mode here; we rely on HTTP endpoints.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

/**
 * Helper to respond with an action menu for the /tickly command. This message
 * contains buttons for the user to start or stop tracking, add a note, create a
 * manual time entry, or assign the current entry to a project.
 */
async function sendActionMenu(respond) {
  await respond({
    text: 'Tickly actions:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Tickly Actions*\nChoose what you’d like to do:' }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Start Tracking' },
            action_id: 'start_tracking'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Stop Tracking' },
            action_id: 'stop_tracking'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Add Note' },
            action_id: 'add_note'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Manual Entry' },
            action_id: 'manual_entry'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Assign Project' },
            action_id: 'assign_project'
          }
        ]
      }
    ]
  });
}

/**
 * /tickly slash command entry point. When a user types `/tickly` in Slack, this
 * handler acknowledges the command and sends back the action menu. Note that
 * respond() posts an in‑channel message by default. You could also use say().
 */
app.command('/tickly', async ({ command, ack, respond }) => {
  await ack();
  await sendActionMenu(respond);
});

/**
 * Start tracking: create a new time entry with the current timestamp and mark it
 * as active. If there’s already an active entry, notify the user instead of
 * creating another one.
 */
app.action('start_tracking', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel.id;
  // Check if the user already has an active entry
  const { data: active, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1);
  if (error) {
    await client.chat.postMessage({ channel: channelId, text: `Error checking active timer: ${error.message}` });
    return;
  }
  if (active && active.length > 0) {
    await client.chat.postMessage({ channel: channelId, text: 'You already have an active timer. Stop it before starting a new one.' });
    return;
  }
  const startTime = new Date().toISOString();
  const { error: insertError } = await supabase.from('time_entries').insert({
    user_id: userId,
    channel_id: channelId,
    start_time: startTime,
    is_active: true
  });
  if (insertError) {
    await client.chat.postMessage({ channel: channelId, text: `Error starting timer: ${insertError.message}` });
  } else {
    await client.chat.postMessage({ channel: channelId, text: 'Started tracking your time.' });
  }
});

/**
 * Stop tracking: find the current active entry, set its end time, calculate the
 * duration, and mark it inactive. If there is no active entry, notify the user.
 */
app.action('stop_tracking', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel.id;
  const { data: active, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1);
  if (error) {
    await client.chat.postMessage({ channel: channelId, text: `Error fetching active timer: ${error.message}` });
    return;
  }
  if (!active || active.length === 0) {
    await client.chat.postMessage({ channel: channelId, text: 'No active timer found.' });
    return;
  }
  const entry = active[0];
  const endTime = new Date().toISOString();
  const durationSeconds = Math.floor((new Date(endTime) - new Date(entry.start_time)) / 1000);
  const { error: updateError } = await supabase
    .from('time_entries')
    .update({ end_time: endTime, duration: durationSeconds, is_active: false })
    .eq('id', entry.id);
  if (updateError) {
    await client.chat.postMessage({ channel: channelId, text: `Error stopping timer: ${updateError.message}` });
  } else {
    await client.chat.postMessage({ channel: channelId, text: 'Stopped tracking your time.' });
  }
});

/**
 * Add a note: open a modal where the user can type a note or title. When the
 * modal is submitted, the view submission handler updates the most recent
 * time entry (active or otherwise) with the note.
 */
app.action('add_note', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'submit_note',
      title: { type: 'plain_text', text: 'Add Note' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'note_input',
          label: { type: 'plain_text', text: 'Title or note' },
          element: {
            type: 'plain_text_input',
            action_id: 'note'
          }
        }
      ]
    }
  });
});

// Handler for the Add Note modal submission
app.view('submit_note', async ({ ack, body, view, client }) => {
  await ack();
  const userId = body.user.id;
  const note = view.state.values['note_input']['note'].value;
  // Find the most recent time entry for the user (active or not)
  const { data: entries, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .order('start_time', { ascending: false })
    .limit(1);
  if (error || !entries || entries.length === 0) {
    await client.chat.postMessage({ channel: userId, text: 'Could not find a time entry to add a note to.' });
    return;
  }
  const entry = entries[0];
  const { error: updateError } = await supabase
    .from('time_entries')
    .update({ title: note })
    .eq('id', entry.id);
  if (updateError) {
    await client.chat.postMessage({ channel: userId, text: `Error adding note: ${updateError.message}` });
  } else {
    await client.chat.postMessage({ channel: userId, text: 'Note added to your time entry.' });
  }
});

/**
 * Manual entry: open a modal to collect a duration (in minutes) and an optional
 * title. When the modal is submitted, create a finished time entry based on
 * the given duration ending now.
 */
app.action('manual_entry', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'submit_manual_entry',
      title: { type: 'plain_text', text: 'Manual Time Entry' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'duration_block',
          label: { type: 'plain_text', text: 'Duration (minutes)' },
          element: {
            type: 'plain_text_input',
            action_id: 'duration'
          }
        },
        {
          type: 'input',
          block_id: 'title_block',
          optional: true,
          label: { type: 'plain_text', text: 'Title or note' },
          element: {
            type: 'plain_text_input',
            action_id: 'title'
          }
        }
      ]
    }
  });
});

// Handler for the Manual Entry modal submission
app.view('submit_manual_entry', async ({ ack, body, view, client }) => {
  await ack();
  const userId = body.user.id;
  const durationMinutes = parseFloat(view.state.values['duration_block']['duration'].value);
  const title = view.state.values['title_block']['title'].value || null;
  if (isNaN(durationMinutes) || durationMinutes <= 0) {
    await client.chat.postMessage({ channel: userId, text: 'Please enter a valid duration.' });
    return;
  }
  const now = new Date();
  const startTime = new Date(now.getTime() - durationMinutes * 60000).toISOString();
  const endTime = now.toISOString();
  const durationSeconds = Math.floor(durationMinutes * 60);
  const { error } = await supabase.from('time_entries').insert({
    user_id: userId,
    start_time: startTime,
    end_time: endTime,
    duration: durationSeconds,
    title,
    is_active: false
  });
  if (error) {
    await client.chat.postMessage({ channel: userId, text: `Error recording manual entry: ${error.message}` });
  } else {
    await client.chat.postMessage({ channel: userId, text: 'Manual time entry recorded.' });
  }
});

/**
 * Assign project: open a modal with a dropdown of the user’s projects. When the
 * modal is submitted, update the current active time entry with the selected
 * project. Projects must exist in a `projects` table with at least id and name.
 */
app.action('assign_project', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  // Fetch projects for this user from Supabase
  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId);
  if (error) {
    await client.chat.postMessage({ channel: userId, text: `Error fetching projects: ${error.message}` });
    return;
  }
  const options = (projects || []).map(p => ({
    text: { type: 'plain_text', text: p.name },
    value: String(p.id)
  }));
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'submit_assign_project',
      title: { type: 'plain_text', text: 'Assign Project' },
      submit: { type: 'plain_text', text: 'Assign' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'project_select_block',
          element: {
            type: 'static_select',
            action_id: 'project',
            placeholder: { type: 'plain_text', text: 'Select a project' },
            options
          },
          label: { type: 'plain_text', text: 'Project' }
        }
      ]
    }
  });
});

// Handler for Assign Project modal submission
app.view('submit_assign_project', async ({ ack, body, view, client }) => {
  await ack();
  const userId = body.user.id;
  const projectId = view.state.values['project_select_block']['project'].selected_option.value;
  // Find active entry
  const { data: active, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1);
  if (error) {
    await client.chat.postMessage({ channel: userId, text: `Error finding active entry: ${error.message}` });
    return;
  }
  if (!active || active.length === 0) {
    await client.chat.postMessage({ channel: userId, text: 'No active time entry to assign a project to.' });
    return;
  }
  const entryId = active[0].id;
  const { error: updateError } = await supabase
    .from('time_entries')
    .update({ project_id: projectId })
    .eq('id', entryId);
  if (updateError) {
    await client.chat.postMessage({ channel: userId, text: `Error assigning project: ${updateError.message}` });
  } else {
    await client.chat.postMessage({ channel: userId, text: 'Project assigned to your active time entry.' });
  }
});

// Start the Bolt app. The ExpressReceiver mounts its router on an internal
// Express app; calling app.start() will run that server on the given port.
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Tickly server is running on port ${port}`);
})();
// Handle Slack's URL verification challenge explicitly
receiver.router.post('/slack/events', (req, res) => {
  const { challenge } = req.body;
  if (challenge) {
    return res.status(200).send(challenge);
  }
});