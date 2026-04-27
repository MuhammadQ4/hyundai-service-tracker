import { supabase } from './supabaseClient'
import { useEffect, useState } from 'react'

function App() {
  const [techs, setTechs] = useState([])

  useEffect(() => {
    supabase.from('technicians').select('*').then(({ data }) => {
      setTechs(data || [])
    })
  }, [])

  return (
    <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h1>Supabase Connection Test</h1>
      {techs.length > 0 ? (
        <div>
          <p style={{ color: 'green', fontWeight: 'bold' }}>Connected! Found {techs.length} technicians:</p>
          <ul>{techs.map(t => <li key={t.id}>{t.name} - {t.available ? 'On Duty' : 'Off Duty'}</li>)}</ul>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  )
}

export default App
