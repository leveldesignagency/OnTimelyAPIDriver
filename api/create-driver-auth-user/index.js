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
    const { email, password, fullName, phone, licenseNumber, company, vehicle, registration } = payload;
    
    if (!email || !password || !fullName || !licenseNumber) {
      return res.status(400).json({ error: 'Missing required fields: email, password, fullName, licenseNumber' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Create the driver auth user
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        provider: 'driver',
        role: 'driver',
        full_name: fullName,
        phone: phone || null,
        license_number: licenseNumber,
        company: company || null,
        vehicle: vehicle || null,
        registration: registration || null,
        email_verified: true
      },
      app_metadata: { provider: 'email', providers: ['email', 'driver'] }
    });

    let authUserId = createData?.user?.id || null;

    if (createError) {
      console.log('CreateDriverUser error:', createError.message);
      if (!String(createError.message || '').includes('already registered')) {
        return res.status(500).json({ error: createError.message });
      }
      console.log('Driver already registered, proceeding to find and update...');
    }

    // If the user already exists, locate and update password/metadata
    if (!authUserId) {
      console.log('Driver already exists, trying to find and update...');
      
      let foundUser = null;
      let page = 1;
      const perPage = 1000;
      
      while (!foundUser && page <= 10) {
        const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ 
          page, 
          perPage 
        });
        
        if (listErr) {
          console.error(`Error listing users page ${page}:`, listErr);
          return res.status(500).json({ error: listErr.message });
        }
        
        foundUser = list.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
        
        if (foundUser) {
          console.log(`Found driver user:`, foundUser.id, foundUser.email);
          break;
        }
        
        if (list.users.length < perPage) {
          break;
        }
        
        page++;
      }
      
      if (!foundUser) {
        return res.status(404).json({ error: 'Driver user not found and could not be created' });
      }
      
      authUserId = foundUser.id;
      
      // Update password and metadata
      const { error: updateError } = await supabase.auth.admin.updateUserById(authUserId, {
        password: password,
        user_metadata: {
          ...(foundUser.user_metadata || {}),
          provider: 'driver',
          role: 'driver',
          full_name: fullName,
          phone: phone || null,
          license_number: licenseNumber,
          company: company || null,
          vehicle: vehicle || null,
          registration: registration || null,
          email_verified: true
        },
        app_metadata: { 
          ...(foundUser.app_metadata || {}),
          provider: 'email', 
          providers: ['email', 'driver'] 
        }
      });
      
      if (updateError) {
        console.error('UpdateDriverUser error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }
    }

    return res.status(200).json({ 
      success: true, 
      user: {
        id: authUserId,
        email: email
      },
      message: 'Driver auth user created successfully'
    });

  } catch (error) {
    console.error('[create-driver-auth-user] error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

