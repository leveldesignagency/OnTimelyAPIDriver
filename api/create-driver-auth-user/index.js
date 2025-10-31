const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

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

    // Generate password reset link so driver can set their password
    let passwordResetLink = null;
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email: email
      });

      if (!linkError && linkData?.properties?.action_link) {
        passwordResetLink = linkData.properties.action_link;
        console.log('Password reset link generated for driver:', email);
      } else {
        console.error('Failed to generate password reset link:', linkError);
      }
    } catch (linkErr) {
      console.error('Error generating password reset link:', linkErr);
      // Don't fail the request if link generation fails
    }

    // Send welcome email to driver with password reset link
    if (passwordResetLink) {
      try {
        const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.VITE_RESEND_API_KEY;
        if (RESEND_API_KEY) {
          const resend = new Resend(RESEND_API_KEY);
          
          // Get driver portal URL from env or use default
          const driverPortalUrl = process.env.DRIVER_PORTAL_URL || 'https://driver.ontimely.co.uk';
          
          await resend.emails.send({
            from: 'OnTimely <noreply@ontimely.co.uk>', // Update with your verified sender domain
            to: email,
            subject: 'Welcome to OnTimely Driver Portal',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #10b981;">Welcome to OnTimely Driver Portal</h2>
                <p>Hello ${fullName},</p>
                <p>Your driver account has been created. To get started, please set your password by clicking the link below:</p>
                <p style="margin: 30px 0;">
                  <a href="${passwordResetLink}" 
                     style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Set Your Password
                  </a>
                </p>
                <p>Or copy and paste this link into your browser:</p>
                <p style="color: #666; word-break: break-all;">${passwordResetLink}</p>
                <p style="margin-top: 30px; color: #666; font-size: 14px;">
                  This link will expire in 24 hours. If you didn't request this account, please ignore this email.
                </p>
                <p style="margin-top: 20px; color: #666; font-size: 14px;">
                  Best regards,<br>The OnTimely Team
                </p>
              </div>
            `
          });
          
          console.log('Welcome email sent successfully to driver:', email);
        } else {
          console.log('RESEND_API_KEY not set - skipping email send. Password reset link:', passwordResetLink);
        }
      } catch (emailErr) {
        console.error('Failed to send welcome email to driver:', emailErr);
        // Don't fail the request if email sending fails - account is still created
      }
    }

    return res.status(200).json({ 
      success: true,
      auth_user_id: authUserId,
      driver_id: driverData?.id || null,
      password_reset_link: passwordResetLink, // Include in response for now
      message: 'Driver auth user created successfully'
    });

  } catch (e) {
    console.error('[create-driver-auth-user] error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
