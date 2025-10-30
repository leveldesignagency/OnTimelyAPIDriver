const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // Basic CORS (allow Electron/desktop app with null origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-token');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Accept POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Server missing Supabase credentials' });
    }

    const payload = req.body || {};
    const { auth_user_id, driver_id } = payload;
    
    if (!auth_user_id && !driver_id) {
      return res.status(400).json({ error: 'Missing required field: auth_user_id or driver_id' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let targetAuthUserId = auth_user_id;

    // If driver_id is provided but not auth_user_id, fetch it from the drivers table
    if (!targetAuthUserId && driver_id) {
      const { data: driverData, error: driverFetchError } = await supabase
        .from('drivers')
        .select('auth_user_id')
        .eq('id', driver_id)
        .single();

      if (driverFetchError || !driverData?.auth_user_id) {
        return res.status(404).json({ error: 'Driver not found' });
      }

      targetAuthUserId = driverData.auth_user_id;
    }

    // 1) Delete from public.drivers table first
    const deleteFilter = targetAuthUserId 
      ? { auth_user_id: targetAuthUserId }
      : { id: driver_id };

    const { error: deleteDriverError } = await supabase
      .from('drivers')
      .delete()
      .match(deleteFilter);

    if (deleteDriverError) {
      console.error('Error deleting driver record:', deleteDriverError);
      return res.status(500).json({ error: 'Failed to delete driver record: ' + deleteDriverError.message });
    }

    // 2) Delete auth user (if auth_user_id exists)
    if (targetAuthUserId) {
      const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(targetAuthUserId);
      
      if (deleteAuthError) {
        console.error('Error deleting auth user:', deleteAuthError);
        // Note: Driver record is already deleted, but log the auth deletion error
        // Don't fail completely if auth user deletion fails (might already be deleted)
        if (!String(deleteAuthError.message || '').includes('not found')) {
          return res.status(500).json({ 
            error: 'Driver record deleted but failed to delete auth user: ' + deleteAuthError.message 
          });
        }
      }
    }

    return res.status(200).json({ 
      success: true,
      message: 'Driver and auth user deleted successfully'
    });

  } catch (e) {
    console.error('[delete-driver-auth-user] error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

