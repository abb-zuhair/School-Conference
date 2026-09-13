(function () {
  'use strict';

  // Stop double submits — parents on slow connections tap "Confirm" twice.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.dataset.submitted === '1') {
      e.preventDefault();
      return;
    }
    form.dataset.submitted = '1';
    var btn = form.querySelector('button[type=submit], button:not([type])');
    if (btn && !btn.classList.contains('cell-btn')) {
      setTimeout(function () {
        btn.disabled = true;
        btn.style.opacity = '.6';
      }, 0);
    }
    // Re-enable if the page is restored from bfcache
    setTimeout(function () {
      form.dataset.submitted = '';
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
      }
    }, 8000);
  });

  // Remember the date a parent was looking at when they come back from a booking
  var dateButtons = document.querySelectorAll('[data-remember-date]');
  dateButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      try {
        sessionStorage.setItem('aca:lastDate', b.dataset.rememberDate);
      } catch (err) {
        /* private mode */
      }
    });
  });
})();
