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

    // Try to create the user first
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
      console.log('CreateUser error:', createError.message);
      if (!String(createError.message || '').includes('already registered')) {
        return res.status(500).json({ error: createError.message });
      }
      console.log('User already registered, proceeding to find and update...');
    }

    // If the user already exists, locate and update password/metadata
    if (!authUserId) {
      console.log('User already exists, trying to find and update...');
      
      let foundUser = null;
      let page = 1;
      const perPage = 1000;
      
      while (!foundUser && page <= 10) {
        console.log(`Searching page ${page} for user: ${email}`);
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
          console.log(`Found user on page ${page}:`, foundUser.id, foundUser.email);
          break;
        }
        
        if (list.users.length < perPage) {
          console.log(`Reached end of users list at page ${page}`);
          break;
        }
        
        page++;
      }
      
      if (!foundUser) {
        console.error('User exists but could not be found:', email);
        return res.status(500).json({ error: 'User exists but could not be found or created' });
      }
      
      console.log('Found existing user, updating password and metadata...');
      const { error: updErr } = await supabase.auth.admin.updateUserById(foundUser.id, {
        password,
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
      if (updErr) {
        console.error('Error updating user:', updErr);
        return res.status(500).json({ error: updErr.message });
      }
      authUserId = foundUser.id;
      console.log('Successfully updated existing user:', authUserId);
    }

    // Insert or update driver record in public.drivers table
    // First check if driver already exists
    const { data: existingDriver, error: checkError } = await supabase
      .from('drivers')
      .select('id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing driver:', checkError);
      return res.status(500).json({ error: 'Database error checking email: ' + checkError.message });
    }

    let driverData = null;
    let driverError = null;

    if (existingDriver) {
      // Update existing driver
      const { data: updateData, error: updateErr } = await supabase
        .from('drivers')
        .update({
          full_name: fullName,
          email: email,
          phone: phone || null,
          license_number: licenseNumber,
          company: company || null,
          vehicle: vehicle || null,
          registration: registration || null,
          role: 'driver'
        })
        .eq('auth_user_id', authUserId)
        .select()
        .single();

      driverData = updateData;
      driverError = updateErr;
    } else {
      // Insert new driver
      const { data: insertData, error: insertErr } = await supabase
        .from('drivers')
        .insert({
          auth_user_id: authUserId,
          full_name: fullName,
          email: email,
          phone: phone || null,
          license_number: licenseNumber,
          company: company || null,
          vehicle: vehicle || null,
          registration: registration || null,
          role: 'driver'
        })
        .select()
        .single();

      driverData = insertData;
      driverError = insertErr;
    }

    if (driverError) {
      console.error('InsertDriver error:', driverError);
      return res.status(500).json({ error: 'Database error creating new user: ' + driverError.message });
    }

    return res.status(200).json({ 
      success: true,
      auth_user_id: authUserId,
      driver_id: driverData?.id || null,
      message: 'Driver auth user created successfully'
    });

  } catch (e) {
    console.error('[create-driver-auth-user] error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
