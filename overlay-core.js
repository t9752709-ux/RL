window.RallyOverlay = {
  renderState(root, state) {
    window.RallyRanks.render(root, window.RallyRanks.overlayView(state));
  }
};
