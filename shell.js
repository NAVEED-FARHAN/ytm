const page = document.querySelector('#youtube-page');

// Configure the guest before assigning src so its document-start preload is
// installed before YouTube renders the first player or ad element.
page.setAttribute('preload', window.youtubeTrayShell.adGuardPreload);
page.src = 'https://www.youtube.com';
