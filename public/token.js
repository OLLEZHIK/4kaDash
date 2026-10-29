'use strict';

const $ = (id) => document.getElementById(id);

$('get').addEventListener('click', async () => {
  $('msg').textContent = '';
  const res = await fetch('/api/data/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (res.status === 401) {
    $('msg').innerHTML = 'Najprv sa <a href="/">prihláste</a> a potom sa sem vráťte.';
    return;
  }
  if (!res.ok) { $('msg').textContent = 'Kľúč sa nepodarilo vytvoriť.'; return; }
  const { token } = await res.json();
  $('key').value = token;
  $('result').hidden = false;
  $('key').select();
});

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('key').value); $('msg').textContent = 'Skopírované.'; }
  catch { $('key').select(); $('msg').textContent = 'Skopírujte kľúč ručne (Ctrl+C).'; }
});
