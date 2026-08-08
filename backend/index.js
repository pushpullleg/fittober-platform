// ============================================
// CONFIGURATION & INITIALIZATION
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// SendGrid Email Client (safe initialization)
let sgMail = null;
try {
  sgMail = require('@sendgrid/mail');
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('✅ SendGrid initialized');
  } else {
    console.warn('⚠️  SendGrid API key not found - email notifications will be disabled');
  }
} catch (error) {
  console.error('❌ Failed to load SendGrid module:', error.message);
  console.warn('⚠️  Email notifications will be disabled');
}

// Database connection pool (optimized for Vercel serverless)
// Guard creation so module import doesn't throw during Vercel build/runtime
let pool = null;
try {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL not set - DB features will be disabled at runtime');
  } else {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1, // Limit to 1 connection for serverless environment
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true, // Allow process to exit when idle
    });

    // Handle pool errors gracefully
    pool.on('error', (err, client) => {
      console.error('Unexpected database error:', err.message);
      console.log('Database connection will be retried on next request');
    });
  }
} catch (err) {
  console.error('❌ Failed to initialize DB pool at module load:', err.message);
  pool = null;
}

// Helper to run queries or fail with a clear error if DB is not configured
async function dbQuery(queryText, params = []) {
  if (!pool) {
    throw new Error('Database not configured (DATABASE_URL missing or pool failed to initialize)');
  }
  return pool.query(queryText, params);
}

// GitHub Gist URLs to poll for fitness data
const GIST_URLS = [
  'https://gist.github.com/pushpullleg/9c7ab834aa55e54fa70f61d501bf019d',
  'https://gist.github.com/pushpullleg/b2ff0075e1556c7b39d6f1bbc9860a90',
  'https://gist.github.com/pushpullleg/b41a48c3557b59ad55d60c08a0bd2517',
  'https://gist.github.com/pushpullleg/5a8d4b337f4e2c5916559b193dc5b1c4'
];

// Email digest configuration
const CELEBRATION_THRESHOLD = 400; // Minutes threshold for celebration emoji (easy to change later)

// ============================================
// DATA PROCESSING FUNCTIONS
// ============================================

/**
 * Normalize member names to ensure consistency
 * @param {string} name - Raw member name from gist
 * @returns {string} - Normalized name with proper capitalization
 */
function normalizeMemberName(name) {
  if (!name) return 'Unknown';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize first letter of each word
}

/**
 * Fetch raw data from a GitHub Gist
 * @param {string} gistUrl - Full URL to the gist
 * @returns {object|null} - Parsed JSON data or null on error
 */
async function fetchGistData(gistUrl) {
  try {
    console.log(`Fetching data from: ${gistUrl}`);
    const response = await axios.get(`${gistUrl}/raw`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Fittober-Tracker/1.0'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${gistUrl}:`, error.message);
    return null;
  }
}

/**
 * Process and store logs from a single gist
 * @param {string} gistUrl - URL of gist to process
 */
async function processGistLogs(gistUrl) {
  const stats = { newRecords: 0, duplicates: 0 };
  const data = await fetchGistData(gistUrl);
  if (!data) return stats;

  // Handle different data structures
  const logs = data.logs || data.activities || (Array.isArray(data) ? data : []);
  
  if (!Array.isArray(logs)) {
    console.log(`No logs array found in gist: ${gistUrl}`);
    return stats;
  }

  console.log(`Processing ${logs.length} logs from ${gistUrl}`);

  for (const log of logs) {
    try {
      // Extract fields with fallbacks for different naming conventions
      const logId = log.id || log.log_id || log.logId;
      const timestamp = log.timestamp || log.ts || log.time;
      const member = normalizeMemberName(log.member || log.name || log.user);
      const activity = log.activity || log.exercise || log.type;
      const duration = log.duration || log.duration_min || log.minutes;
      const teamName = log.teamName || log.team || log.device_team || 'Fittober';

      // Validate required fields
      if (!logId || !member || !activity || !duration) {
        console.log(`Skipping invalid log:`, { logId, member, activity, duration });
        continue;
      }
      
      // Insert into database with conflict resolution
      const insertQuery = `
        INSERT INTO activities (
          log_id, member, activity, duration_min, ts, device_team, source_gist, raw_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (log_id, source_gist) DO NOTHING
        RETURNING uid
      `;
      
      const result = await dbQuery(insertQuery, [
        logId.toString(),
        member,
        activity,
        parseInt(duration),
        new Date(timestamp),
        teamName,
        gistUrl,
        JSON.stringify(log)
      ]);

      // If a new record was inserted, log it
      if (result.rows.length > 0) {
        stats.newRecords++;
        console.log(`✅ New activity logged: ${member} - ${activity} (${duration} min)`);
      } else {
        stats.duplicates++;
      }

    } catch (error) {
      console.error('Error processing individual log:', error.message);
    }
  }
  
  return stats;
}

/**
 * Poll all GitHub Gists and store new activities
 * This runs every 15 minutes via GitHub Actions
 */
async function pollAllGists() {
  console.log(`🔍 Starting to poll ${GIST_URLS.length} gists...`);
  const startTime = Date.now();
  const stats = {
    totalGists: GIST_URLS.length,
    processed: 0,
    errors: 0,
    newRecords: 0,
    duplicates: 0
  };
  
  for (const gistUrl of GIST_URLS) {
    try {
      console.log(`📝 Processing: ${gistUrl}`);
      const gistStartTime = Date.now();
      
      const result = await processGistLogs(gistUrl);
      const gistDuration = Date.now() - gistStartTime;
      
      stats.processed++;
      if (result && result.newRecords) {
        stats.newRecords += result.newRecords;
      }
      if (result && result.duplicates) {
        stats.duplicates += result.duplicates;
      }
      
      console.log(`✅ Gist processed in ${gistDuration}ms - ${result ? result.newRecords : 0} new, ${result ? result.duplicates : 0} duplicates`);
    } catch (error) {
      stats.errors++;
      console.error(`❌ Error processing gist ${gistUrl}:`, error.message);
      console.error('Stack:', error.stack);
    }
  }
  
  const totalDuration = Date.now() - startTime;
  console.log(`🏁 Polling cycle completed in ${totalDuration}ms`);
  console.log(`📊 Stats:`, stats);
  
  return stats;
}

// ============================================
// MIDDLEWARE
// ============================================

// CORS configuration (allow requests from GitHub Pages)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================
// API ENDPOINTS
// ============================================

// Root endpoint - API information
app.get('/', (req, res) => {
  res.json({
    message: '🏃‍♂️ Fittober Fitness Tracker API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      aggregates: '/aggregates.json'
    },
    status: 'running'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    gists: GIST_URLS.length,
    environment: {
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasSendGridKey: !!process.env.SENDGRID_API_KEY,
      nodeEnv: process.env.NODE_ENV || 'not set'
    }
  });
});

// Alias for deployments that route /api/* to the function without preserving the prefix.
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    gists: GIST_URLS.length,
    environment: {
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasSendGridKey: !!process.env.SENDGRID_API_KEY,
      nodeEnv: process.env.NODE_ENV || 'not set'
    }
  });
});

// Debug endpoint to test database connection
app.get('/api/debug/db', async (req, res) => {
  try {
  const result = await dbQuery('SELECT NOW() as current_time, COUNT(*) as activity_count FROM activities');
    res.json({
      success: true,
      dbConnected: true,
      currentTime: result.rows[0].current_time,
      activityCount: result.rows[0].activity_count
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      dbConnected: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Aggregates endpoint
app.get('/aggregates.json', async (req, res) => {
  try {
    // Get member totals
    const memberTotalsQuery = `
      SELECT member as name, SUM(duration_min) as total_min 
      FROM activities 
      GROUP BY member 
      ORDER BY total_min DESC
    `;
    
  const memberTotals = await dbQuery(memberTotalsQuery);

    // Get overall total
    const overallTotalQuery = `
      SELECT SUM(duration_min) as total_min 
      FROM activities
    `;
    
  const overallTotal = await dbQuery(overallTotalQuery);

    res.json({
      members: memberTotals.rows,
      total_min: overallTotal.rows[0].total_min || 0,
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching aggregates:', error);
    res.json({
      members: [],
      total_min: 0,
      last_updated: new Date().toISOString(),
      warning: 'Database unavailable, showing empty dashboard',
      error: error.message
    });
  }
});

app.get('/api/aggregates.json', async (req, res) => {
  try {
    const memberTotalsQuery = `
      SELECT member as name, SUM(duration_min) as total_min 
      FROM activities 
      GROUP BY member 
      ORDER BY total_min DESC
    `;

    const memberTotals = await dbQuery(memberTotalsQuery);

    const overallTotalQuery = `
      SELECT SUM(duration_min) as total_min 
      FROM activities
    `;

    const overallTotal = await dbQuery(overallTotalQuery);

    res.json({
      members: memberTotals.rows,
      total_min: overallTotal.rows[0].total_min || 0,
      last_updated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching aggregates:', error);
    res.json({
      members: [],
      total_min: 0,
      last_updated: new Date().toISOString(),
      warning: 'Database unavailable, showing empty dashboard',
      error: error.message
    });
  }
});

// Add /api prefix routes for Vercel serverless compatibility
app.get('/api', (req, res) => {
  res.json({
    message: '🏃‍♂️ Fittober Fitness Tracker API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      aggregates: '/api/aggregates.json'
    },
    status: 'running'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    gists: GIST_URLS.length
  });
});

app.get('/api/aggregates.json', async (req, res) => {
  try {
    const memberTotalsQuery = `
      SELECT member as name, SUM(duration_min) as total_min 
      FROM activities 
      GROUP BY member 
      ORDER BY total_min DESC
    `;
    
  const memberTotals = await dbQuery(memberTotalsQuery);

    const overallTotalQuery = `
      SELECT SUM(duration_min) as total_min 
      FROM activities
    `;
    
  const overallTotal = await dbQuery(overallTotalQuery);

    res.json({
      members: memberTotals.rows,
      total_min: overallTotal.rows[0].total_min || 0,
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching aggregates:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message 
    });
  }
});

// Recent activities endpoint
app.get('/api/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    
    const recentActivitiesQuery = `
      SELECT member, activity, duration_min, ts 
      FROM activities 
      ORDER BY ts DESC 
      LIMIT $1
    `;
    
  const result = await dbQuery(recentActivitiesQuery, [limit]);

    res.json({
      activities: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching recent activities:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message 
    });
  }
});

// Manual refresh endpoint to trigger data fetch
app.post('/api/refresh', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔄 Manual refresh triggered at:', new Date().toISOString());
    console.log('📍 Environment check:');
    console.log('  - DATABASE_URL configured:', !!process.env.DATABASE_URL);
    console.log('  - GIST_URLS count:', GIST_URLS.length);
    
    const result = await pollAllGists();
    const duration = Date.now() - startTime;
    
    console.log(`✅ Refresh completed in ${duration}ms`);
    
    res.json({ 
      success: true,
      message: 'Data refreshed successfully',
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      stats: result
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Error during manual refresh:', error);
    console.error('Stack trace:', error.stack);
    console.error(`Failed after ${duration}ms`);
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to refresh data',
      message: error.message,
      duration: `${duration}ms`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET version of refresh for easier testing
app.get('/api/refresh', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔄 Manual refresh triggered (GET) at:', new Date().toISOString());
    console.log('📍 Environment check:');
    console.log('  - DATABASE_URL configured:', !!process.env.DATABASE_URL);
    console.log('  - GIST_URLS count:', GIST_URLS.length);
    
    const result = await pollAllGists();
    const duration = Date.now() - startTime;
    
    console.log(`✅ Refresh completed in ${duration}ms`);
    
    res.json({ 
      success: true,
      message: 'Data refreshed successfully',
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      stats: result
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Error during manual refresh:', error);
    console.error('Stack trace:', error.stack);
    console.error(`Failed after ${duration}ms`);
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to refresh data',
      message: error.message,
      duration: `${duration}ms`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/refresh', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔄 Manual refresh triggered (GET) at:', new Date().toISOString());
    console.log('📍 Environment check:');
    console.log('  - DATABASE_URL configured:', !!process.env.DATABASE_URL);
    console.log('  - GIST_URLS count:', GIST_URLS.length);
    
    const result = await pollAllGists();
    const duration = Date.now() - startTime;
    
    console.log(`✅ Refresh completed in ${duration}ms`);
    
    res.json({ 
      success: true,
      message: 'Data refreshed successfully',
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      stats: result
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Error during manual refresh:', error);
    console.error('Stack trace:', error.stack);
    console.error(`Failed after ${duration}ms`);
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to refresh data',
      message: error.message,
      duration: `${duration}ms`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Webhook endpoint to receive GitHub Gist update notifications
app.post('/api/webhook', async (req, res) => {
  const startTime = new Date();
  console.log('📬 Webhook received at:', startTime.toISOString());
  console.log('From GitHub:', req.headers['user-agent']);
  
  // Respond immediately to GitHub so it knows we received it (GitHub has 10 second timeout)
  res.status(200).json({ 
    success: true,
    message: 'Webhook received, processing in background',
    timestamp: startTime.toISOString()
  });
  
  // Process the webhook in background (after responding to GitHub)
  try {
    console.log('🔄 Starting automatic data refresh from webhook...');
    
    // Fetch new data from all Gists and update database
    await pollAllGists();
    
    const endTime = new Date();
    const duration = endTime - startTime;
    
    console.log(`✅ Webhook processing completed in ${duration}ms`);
    console.log('💬 SMS notifications sent (if configured in pollAllGists)');
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
    console.error('Stack:', error.stack);
  }
});

// ============================================
// EMAIL DIGEST ENDPOINTS
// ============================================

/**
 * Send daily email digest to all team members
 * Triggered by GitHub Actions at 2 PM CDT
 * GET/POST /api/send-digest
 */
app.route('/api/send-digest')
  .get(sendDigestHandler)
  .post(sendDigestHandler);

app.route('/send-digest')
  .get(sendDigestHandler)
  .post(sendDigestHandler);

async function sendDigestHandler(req, res) {
  console.log('📧 Email digest triggered at:', new Date().toISOString());
  
  try {
    if (!sgMail || !process.env.SENDGRID_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'SendGrid not configured or module not available'
      });
    }

    // Get activities from last 24 hours
    const todayStart = new Date();
    todayStart.setHours(todayStart.getHours() - 24); // Last 24 hours
    
    const activitiesQuery = `
      SELECT member, activity, duration_min, ts as timestamp
      FROM activities
      WHERE ts >= $1
      ORDER BY ts DESC
    `;
    
  const activitiesResult = await dbQuery(activitiesQuery, [todayStart]);
    const todayActivities = activitiesResult.rows;

    // Get overall team standings
    const standingsQuery = `
      SELECT member as member_name, SUM(duration_min) as total_minutes
      FROM activities
      GROUP BY member
      ORDER BY total_minutes DESC
    `;
    
  const standingsResult = await dbQuery(standingsQuery);
    const teamStandings = standingsResult.rows;
    
    const totalMinutes = teamStandings.reduce((sum, m) => sum + parseInt(m.total_minutes), 0);

    // Calculate team total for last 24 hours
    const last24HoursQuery = `
      SELECT COALESCE(SUM(duration_min), 0) as total_24h
      FROM activities
      WHERE ts >= $1
    `;
    const last24HoursResult = await dbQuery(last24HoursQuery, [todayStart]);
    const last24HoursTotal = parseInt(last24HoursResult.rows[0].total_24h);

    // Calculate days remaining
    const challengeEnd = new Date('2025-10-31T23:59:59');
    const now = new Date();
    const daysRemaining = Math.ceil((challengeEnd - now) / (1000 * 60 * 60 * 24));

    // Generate HTML email
    const emailHtml = generateDigestEmail(todayActivities, teamStandings, totalMinutes, daysRemaining, last24HoursTotal);

    // Send email to all team members
    const recipients = process.env.EMAIL_RECIPIENTS 
      ? process.env.EMAIL_RECIPIENTS.split(',').map(email => email.trim())
      : [];

    if (recipients.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'No email recipients configured'
      });
    }

    const msg = {
      to: recipients,
      from: process.env.SENDGRID_FROM_EMAIL || 'fittober@yourdomain.com',
      subject: `🏋️ Fittober Update: ${todayActivities.length} activities logged today`,
      html: emailHtml,
    };

    await sgMail.send(msg);

    console.log(`✅ Email digest sent to ${recipients.length} recipients`);
    
    res.json({
      success: true,
      message: 'Email digest sent successfully',
      recipients: recipients.length,
      activitiesToday: todayActivities.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error sending email digest:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to send email digest',
      message: error.message
    });
  }
}

/**
 * Test endpoint - sends digest email to only one recipient (for testing)
 * GET /api/test-digest
 */
app.get('/api/test-digest', async (req, res) => {
  console.log('📧 TEST Email digest triggered at:', new Date().toISOString());
  
  try {
    if (!sgMail || !process.env.SENDGRID_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'SendGrid not configured or module not available'
      });
    }

    // Get activities from last 24 hours
    const todayStart = new Date();
    todayStart.setHours(todayStart.getHours() - 24); // Last 24 hours
    
    const activitiesQuery = `
      SELECT member, activity, duration_min, ts as timestamp
      FROM activities
      WHERE ts >= $1
      ORDER BY ts DESC
    `;
    
  const activitiesResult = await dbQuery(activitiesQuery, [todayStart]);
    const todayActivities = activitiesResult.rows;

    // Get overall team standings
    const standingsQuery = `
      SELECT member as member_name, SUM(duration_min) as total_minutes
      FROM activities
      GROUP BY member
      ORDER BY total_minutes DESC
    `;
    
  const standingsResult = await dbQuery(standingsQuery);
    const teamStandings = standingsResult.rows;
    
    const totalMinutes = teamStandings.reduce((sum, m) => sum + parseInt(m.total_minutes), 0);

    // Calculate team total for last 24 hours
    const last24HoursQuery = `
      SELECT COALESCE(SUM(duration_min), 0) as total_24h
      FROM activities
      WHERE ts >= $1
    `;
    const last24HoursResult = await dbQuery(last24HoursQuery, [todayStart]);
    const last24HoursTotal = parseInt(last24HoursResult.rows[0].total_24h);

    // Calculate days remaining
    const challengeEnd = new Date('2025-10-31T23:59:59');
    const now = new Date();
    const daysRemaining = Math.ceil((challengeEnd - now) / (1000 * 60 * 60 * 24));

    // Generate HTML email
    const emailHtml = generateDigestEmail(todayActivities, teamStandings, totalMinutes, daysRemaining, last24HoursTotal);

    // Send email ONLY to Mukesh for testing
    const testRecipient = process.env.SENDGRID_FROM_EMAIL || 'mravichandr@leomail.tamuc.edu';

    const msg = {
      to: testRecipient,
      from: process.env.SENDGRID_FROM_EMAIL || 'fittober@yourdomain.com',
      subject: `[TEST] 🏋️ Fittober Update: ${todayActivities.length} activities logged today`,
      html: emailHtml,
    };

    await sgMail.send(msg);

    console.log(`✅ TEST Email digest sent to ${testRecipient}`);
    
    res.json({
      success: true,
      message: 'TEST email digest sent successfully (only to you)',
      recipient: testRecipient,
      activitiesToday: todayActivities.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error sending TEST email digest:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to send TEST email digest',
      message: error.message
    });
  }
});

// ============================================
// EMAIL TEMPLATE FUNCTIONS
// ============================================

/**
 * Generate HTML email for daily digest
 * @param {Array} todayActivities - Activities logged today
 * @param {Array} teamStandings - Overall team standings
 * @param {number} totalMinutes - Total minutes by all members
 * @param {number} daysRemaining - Days until challenge ends
 * @returns {string} - HTML email template
 */
function generateDigestEmail(todayActivities, teamStandings, totalMinutes, daysRemaining, last24HoursTotal) {
  // Group today's activities by member
  const activitiesByMember = {};
  todayActivities.forEach(activity => {
    if (!activitiesByMember[activity.member]) {
      activitiesByMember[activity.member] = [];
    }
    activitiesByMember[activity.member].push(activity);
  });

  // Calculate today's totals per member
  const todayTotals = {};
  Object.keys(activitiesByMember).forEach(member => {
    todayTotals[member] = activitiesByMember[member].reduce(
      (sum, a) => sum + parseInt(a.duration_min), 
      0
    );
  });

  // Generate activities section
  let activitiesHtml = '';
  Object.keys(activitiesByMember).forEach(member => {
    const activities = activitiesByMember[member];
    const firstName = member.split(' ')[0];
    
    activitiesHtml += `
      <div style="background: #f8f9fa !important; border-left: 4px solid #00386C; padding: 15px; margin-bottom: 15px; border-radius: 5px;">
        <h3 style="color: #00386C !important; margin: 0 0 10px 0; font-size: 18px;">${firstName}</h3>
        <ul style="margin: 0; padding-left: 20px; color: #333 !important;">
    `;
    
    activities.forEach(activity => {
      const time = new Date(activity.timestamp).toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Chicago' // CST timezone
      });
      activitiesHtml += `<li style="margin: 5px 0; color: #333 !important;">${activity.activity} - ${activity.duration_min} mins (${time})</li>`;
    });
    
    activitiesHtml += `
        </ul>
        <p style="margin: 10px 0 0 0; font-weight: bold; color: #FFC333 !important;">Total in last 24 hours: ${todayTotals[member]} mins</p>
      </div>
    `;
  });

  // Generate standings HTML
  let standingsHtml = '';
  teamStandings.forEach((member, index) => {
    const firstName = member.member_name.split(' ')[0];
    const percentage = ((parseInt(member.total_minutes) / totalMinutes) * 100).toFixed(1);
    standingsHtml += `
      <tr style="background: white !important;">
        <td style="padding: 10px; border-bottom: 1px solid #ddd; color: #333 !important;">${firstName}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; font-weight: bold; color: #00386C !important;">${member.total_minutes} mins</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666 !important;">${percentage}%</td>
      </tr>
    `;
  });

  // Determine performance emoji based on 24-hour total
  const performanceEmoji = last24HoursTotal >= CELEBRATION_THRESHOLD ? '🎉' : '😢';

  // Embedded dashboard image (using Chart.js via QuickChart)
  const chartData = teamStandings.map(m => parseInt(m.total_minutes));
  const chartLabels = teamStandings.map(m => m.member_name.split(' ')[0]);
  const chartColors = ['#FFC333', '#1172DE', '#10B981', '#F26839'];
  
  const chartConfig = {
    type: 'doughnut',
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        backgroundColor: chartColors,
        borderWidth: 3,
        borderColor: '#ffffff'
      }]
    },
    options: {
      plugins: {
        legend: { display: false },
        datalabels: {
          color: '#fff',
          font: { size: 16, weight: 'bold' },
          formatter: (value) => value + ' min'
        },
        doughnutlabel: {
          labels: [
            {
              text: totalMinutes.toString(),
              font: { size: 48, weight: 'bold' },
              color: '#000000'
            },
            {
              text: 'min',
              font: { size: 24 },
              color: '#000000'
            }
          ]
        }
      },
      cutout: '65%',
      backgroundColor: '#f0f0f0'
    }
  };
  
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&width=500&height=300`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <style>
    :root { color-scheme: light only; }
  </style>
</head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5 !important; color-scheme: light;">
  <div style="max-width: 600px; margin: 0 auto; background: white !important; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #00386C 0%, #1172DE 100%) !important; color: white !important; padding: 30px 20px; text-align: center;">
      <h1 style="margin: 0 0 10px 0; font-size: 24px; font-weight: 800; color: white !important;">The Excel-erators</h1>
      <p style="margin: 0; font-size: 16px; opacity: 0.9; color: white !important;">Fittober 2025 Daily Update</p>
      <p style="margin: 10px 0 0 0; font-size: 14px; background: rgba(255,255,255,0.2) !important; display: inline-block; padding: 5px 15px; border-radius: 20px; color: white !important;">
        ⏰ ${daysRemaining} days remaining
      </p>
    </div>

    <!-- Dashboard Chart -->
    <div style="padding: 30px 20px; text-align: center; background: #fafafa !important;">
      <h2 style="color: #00386C !important; margin: 0 0 10px 0;">📊 Team Progress</h2>
      <p style="color: #00386C !important; font-size: 18px; font-weight: bold; margin: 0 0 20px 0; background: #FFC333 !important; padding: 10px; border-radius: 8px; display: inline-block;">
        Last 24 hrs: ${last24HoursTotal} min ${performanceEmoji}
      </p>
      <img src="${chartUrl}" alt="Team Activity Chart" style="max-width: 100%; height: auto; border-radius: 10px;" />
      <p style="margin: 15px 0 0 0;">
        <a href="https://pushpullleg.github.io/fitness-tracker/" style="display: inline-block; background: #FFC333 !important; color: #00386C !important; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px;">
          View Live Dashboard →
        </a>
      </p>
    </div>

    <!-- Today's Activities -->
    <div style="padding: 30px 20px; background: white !important;">
      <h2 style="color: #00386C !important; margin: 0 0 5px 0; border-bottom: 3px solid #FFC333; padding-bottom: 10px;">
        Today's Activities
      </h2>
      <p style="color: #666 !important; margin: 5px 0 20px 0; font-size: 14px;">(${todayActivities.length} total)</p>
      ${activitiesHtml || '<p style="color: #666 !important; text-align: center; padding: 20px;">No activities logged today yet. Get moving!</p>'}
    </div>

    <!-- Team Standings -->
    <div style="padding: 0 20px 30px 20px; background: white !important;">
      <h2 style="color: #00386C !important; margin: 0 0 20px 0; border-bottom: 3px solid #FFC333; padding-bottom: 10px;">
        Individual Contribution
      </h2>
      <table style="width: 100%; border-collapse: collapse; background: white !important;">
        <thead>
          <tr style="background: #00386C !important; color: white !important;">
            <th style="padding: 12px; text-align: left; color: white !important;">Member</th>
            <th style="padding: 12px; text-align: right; color: white !important;">Total Minutes</th>
            <th style="padding: 12px; text-align: right; color: white !important;">% of Team</th>
          </tr>
        </thead>
        <tbody>
          ${standingsHtml}
        </tbody>
        <tfoot>
          <tr style="background: #FFC333 !important; font-weight: bold; color: #00386C !important;">
            <td style="padding: 12px; color: #00386C !important;">Team Total</td>
            <td style="padding: 12px; text-align: right; color: #00386C !important;" colspan="2">${totalMinutes} minutes</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Footer -->
    <div style="background: #f8f9fa !important; padding: 20px; text-align: center; border-top: 1px solid #ddd;">
      <p style="margin: 0; color: #666 !important; font-size: 14px;">
        Keep crushing it, Excel-erators! 💪
      </p>
      <p style="margin: 10px 0 0 0; color: #999 !important; font-size: 12px;">
        You're receiving this because you're part of The Excel-erators team.<br>
        Challenge ends October 31, 2025
      </p>
    </div>

  </div>
</body>
</html>
  `;
}

// Start polling in background if not in serverless environment
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  // Start polling every 60 seconds (only for local development)
  setInterval(pollAllGists, 60000);
  
  // Initial poll
  pollAllGists();
  
  console.log('📡 Started polling GitHub Gists every 60 seconds');
}

// For Vercel serverless: Export the Express app
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // For local development: Start server
  app.listen(port, () => {
    console.log(`🚀 Fittober Tracker server running on port ${port}`);
    console.log(`📊 Aggregates available at: http://localhost:${port}/aggregates.json`);
    console.log(`❤️  Health check at: http://localhost:${port}/health`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    pool.end();
    process.exit(0);
  });
}
