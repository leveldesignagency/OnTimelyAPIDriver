# OnTimely Driver API

Standalone API endpoint for creating driver authentication users for the OnTimely Driver Portal.

## Setup

1. **GitHub Repository**
   - Create a new GitHub repo called `OnTimelyAPIDriver`
   - Push this folder to GitHub

2. **Vercel Deployment**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click "Add New Project"
   - Import the `OnTimelyAPIDriver` GitHub repo
   - Project name: `ontimely-api-driver` (or your preference)

3. **Environment Variables** (in Vercel project settings)
   Add these:
   ```
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   ```
   Or:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   ```

4. **Deploy**
   - Vercel will auto-deploy on push to main
   - Your endpoint will be: `https://ontimely-api-driver.vercel.app/api/create-driver-auth-user`

## Endpoint

**POST** `/api/create-driver-auth-user`

**Request Body:**
```json
{
  "email": "driver@example.com",
  "password": "temp_password_123",
  "fullName": "John Driver",
  "phone": "+1234567890",
  "licenseNumber": "DL123456",
  "company": "Transport Co",
  "vehicle": "Mercedes E-Class",
  "registration": "ABC123"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "uuid-here",
    "email": "driver@example.com"
  },
  "message": "Driver auth user created successfully"
}
```

