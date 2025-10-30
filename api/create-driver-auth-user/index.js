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
      console.error('Missing Supabase credentials:', {
        hasUrl: !!SUPABASE_URL,
        hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
        keyLength: SUPABASE_SERVICE_ROLE_KEY?.length || 0
      });
      return res.status(500).json({ error: 'Server missing Supabase credentials' });
    }

    // Verify service role key format (should be a JWT)
    if (!SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ')) {
      console.error('Service role key appears invalid - should start with "eyJ"');
      return res.status(500).json({ error: 'Invalid service role key format' });
    }

    const payload = req.body || {};
    const { email, password, fullName, phone, licenseNumber, company, vehicle, registration } = payload;
    
    if (!email || !password || !fullName || !licenseNumber) {
      return res.status(400).json({ error: 'Missing required fields: email, password, fullName, licenseNumber' });
    }

    console.log('Creating Supabase client with Admin API...');
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Test Admin API access by listing users (first page only)
    console.log('Testing Admin API access...');
    const { data: testList, error: testError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1
    });
    
    if (testError) {
      console.error('Admin API access test failed:', testError);
      return res.status(500).json({ 
        error: 'Admin API not accessible - check service role key and Supabase Auth settings',
        details: testError.message || testError
      });
    }
    
    console.log('Admin API access confirmed');

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
      console.error('CreateDriverUser error:', createError);
      console.error('Error details:', JSON.stringify(createError, null, 2));
      
      // Check for specific error types
      if (String(createError.message || '').includes('already registered') || 
          String(createError.message || '').includes('already exists')) {
        console.log('Driver already registered, proceeding to find and update...');
      } else if (String(createError.message || '').includes('not allowed') ||
                 String(createError.message || '').includes('permission') ||
                 String(createError.message || '').includes('User not allowed')) {
        return res.status(500).json({ 
          error: 'User not allowed - check Supabase Auth settings and service role key permissions',
          details: createError.message
        });
      } else {
        return res.status(500).json({ 
          error: createError.message || 'Failed to create driver user',
          details: createError
        });
      }
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

    // Insert or update driver record in public.drivers table
    const { data: driverData, error: driverError } = await supabase
      .from('drivers')
      .upsert({
        auth_user_id: authUserId,
        full_name: fullName,
        email: email,
        phone: phone || null,
        license_number: licenseNumber,
        company: company || null,
        vehicle: vehicle || null,
        registration: registration || null,
        role: 'driver'
      }, {
        onConflict: 'auth_user_id'
      })
      .select()
      .single();

    if (driverError) {
      console.error('InsertDriver error:', driverError);
      // Don't fail the request if driver record insert fails - auth user is created
      // Just log it for now
    }

    return res.status(200).json({ 
      success: true, 
      user: {
        id: authUserId,
        email: email
      },
      driver_id: driverData?.id || null,
      message: 'Driver auth user created successfully'
    });

  } catch (error) {
    console.error('[create-driver-auth-user] error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

