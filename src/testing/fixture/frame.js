'use strict';

document.getElementById('frame-button').addEventListener('click', () => {
  document.getElementById('frame-output').textContent = 'Metrics loaded from inside the iframe.';
});
