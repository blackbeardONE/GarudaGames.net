(function () {
  var nav = document.getElementById("site-nav");
  var toggle = document.querySelector(".nav-toggle");
  var header = document.querySelector(".site-header");
  var gamesBtn = document.getElementById("nav-games-btn");
  var gamesPanel = document.getElementById("nav-games-panel");

  function closeGamesMenu() {
    if (!gamesBtn || !gamesPanel) return;
    gamesBtn.setAttribute("aria-expanded", "false");
    gamesPanel.setAttribute("hidden", "");
  }

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      nav.classList.toggle("is-open", !open);
      closeGamesMenu();
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        toggle.setAttribute("aria-expanded", "false");
        nav.classList.remove("is-open");
        closeGamesMenu();
      });
    });
  }

  if (gamesBtn && gamesPanel) {
    gamesBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = gamesBtn.getAttribute("aria-expanded") === "true";
      gamesBtn.setAttribute("aria-expanded", String(!open));
      if (open) {
        gamesPanel.setAttribute("hidden", "");
      } else {
        gamesPanel.removeAttribute("hidden");
      }
    });

    gamesPanel.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    document.addEventListener("click", function () {
      closeGamesMenu();
    });
  }

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 24);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Hero game slider */
  var slides = document.querySelectorAll(".game-slide");
  var dotsRoot = document.getElementById("game-slider-dots");
  var prevBtn = document.querySelector(".hero-slider__btn--prev");
  var nextBtn = document.querySelector(".hero-slider__btn--next");

  if (!slides.length || !dotsRoot) return;

  var current = 0;
  var total = slides.length;
  var autoplayMs = 6500;
  var timer = null;

  function setSlide(i) {
    current = ((i % total) + total) % total;
    slides.forEach(function (slide, j) {
      var on = j === current;
      slide.classList.toggle("is-active", on);
      slide.setAttribute("aria-hidden", on ? "false" : "true");
    });
    dotsRoot.querySelectorAll(".hero-slider__dot").forEach(function (dot, j) {
      var on = j === current;
      dot.classList.toggle("is-active", on);
      dot.setAttribute("aria-selected", on ? "true" : "false");
      dot.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  for (var d = 0; d < total; d++) {
    (function (idx) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "hero-slider__dot" + (idx === 0 ? " is-active" : "");
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-selected", idx === 0 ? "true" : "false");
      dot.setAttribute("tabindex", idx === 0 ? "0" : "-1");
      dot.setAttribute(
        "aria-label",
        "Show " + slides[idx].getAttribute("data-game").replace(/-/g, " ")
      );
      dot.addEventListener("click", function () {
        setSlide(idx);
        resetAutoplay();
      });
      dotsRoot.appendChild(dot);
    })(d);
  }

  function next() {
    setSlide(current + 1);
  }

  function prev() {
    setSlide(current - 1);
  }

  function resetAutoplay() {
    if (!timer) return;
    clearInterval(timer);
    timer = setInterval(next, autoplayMs);
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      next();
      resetAutoplay();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      prev();
      resetAutoplay();
    });
  }

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function startAutoplay() {
    if (reduceMotion.matches) return;
    stopAutoplay();
    timer = setInterval(next, autoplayMs);
  }

  function stopAutoplay() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  startAutoplay();

  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", function () {
      stopAutoplay();
      startAutoplay();
    });
  } else {
    reduceMotion.addListener(function () {
      stopAutoplay();
      startAutoplay();
    });
  }
})();
