document.addEventListener("DOMContentLoaded", () => {
  if (!window.gsap) return;
  if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  const menuBtn = document.getElementById("menu-btn");
  const fullMenu = document.getElementById("full-menu");
  const menuLinks = document.querySelectorAll(".menu-item a");
  const header = document.querySelector(".header-main");

  /* Menu */
  if (menuBtn && fullMenu) {
    menuBtn.addEventListener("click", () => {
      const isOpen = menuBtn.classList.toggle("active");
      fullMenu.classList.toggle("active");
      menuBtn.setAttribute("aria-expanded", String(isOpen));
      menuBtn.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");

      if (isOpen) {
        gsap.to(menuLinks, {
          opacity: 1,
          y: 0,
          duration: 0.85,
          stagger: 0.08,
          ease: "power4.out",
          delay: 0.25,
        });
        gsap.to(".menu-footer", { opacity: 1, delay: 0.55, duration: 0.5 });
      } else {
        gsap.to(menuLinks, { opacity: 0, y: 20, duration: 0.28, stagger: 0.05 });
        gsap.to(".menu-footer", { opacity: 0, duration: 0.2 });
      }
    });
  }

  menuLinks.forEach((link) => {
    link.addEventListener("click", () => {
      menuBtn?.classList.remove("active");
      fullMenu?.classList.remove("active");
      gsap.to(menuLinks, { opacity: 0, y: 20, duration: 0.2 });
      gsap.to(".menu-footer", { opacity: 0, duration: 0.2 });
    });
  });

  /* Header scrolled */
  const syncHeader = () => {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 16);
  };
  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });

  /* Lenis smooth scrolling (optional) */
  let lenis = null;
  if (window.Lenis) {
    lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
      smoothTouch: false,
    });
    if (window.ScrollTrigger) lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);
  }

  /* Smooth anchor links (uses Lenis if available) */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || href === "#") return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      if (lenis) {
        lenis.scrollTo(target, { offset: -90, duration: 1.1, easing: (t) => 1 - Math.pow(1 - t, 3) });
      } else {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  /* Split text (optional) */
  if (window.SplitType) {
    document.querySelectorAll("[data-split]").forEach((el) => {
      try {
        // eslint-disable-next-line no-new
        new SplitType(el, {
          types: el.getAttribute("data-split") || "lines",
          lineClass: "line",
          wordClass: "word",
          charClass: "char",
        });
      } catch (_) {
        // no-op (keeps content readable)
      }
    });
  }

  /* HOME (Premium v2) */
  const homeHero = document.querySelector(".p-hero");
  if (homeHero) {
    gsap.set(".p-hero-bg", { transformOrigin: "50% 50%" });

    const tl = gsap.timeline({ defaults: { ease: "power4.out" } });
    tl.from(".p-logo-letter", { yPercent: 130, opacity: 0, scale: 0.88, filter: "blur(14px)", duration: 1.15, stagger: 0.07, clearProps: "filter,scale" })
      .from(".p-lead", { y: 18, opacity: 0, duration: 0.85 }, "-=0.5")
      .from(".p-cta-row .p-btn", { y: 12, opacity: 0, duration: 0.65, stagger: 0.1 }, "-=0.45")
      .from(".p-stamp-inline", { opacity: 0, y: -12, duration: 0.65 }, "-=0.6");

    if (window.ScrollTrigger) {
      const splitTl = gsap.timeline({
        scrollTrigger: {
          trigger: ".p-hero",
          start: "top top",
          end: "+=90%",
          scrub: true,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      });

      splitTl
        .to(".p-hero-fade", { opacity: 0, y: -10, duration: 0.35, ease: "power2.out" }, 0)
        .to(".p-hero-takeover", { opacity: 1, duration: 1, ease: "none" }, 0)
        // DA / RE: separate AND fade until gone
        .to(".p-logo-part.left", { x: -220, opacity: 1, duration: 0.35, ease: "none" }, 0)
        .to(".p-logo-part.right", { x: 220, opacity: 1, duration: 0.35, ease: "none" }, 0)
        .to(".p-logo-part.left", { x: -620, opacity: 0, duration: 0.65, ease: "none" }, 0.35)
        .to(".p-logo-part.right", { x: 620, opacity: 0, duration: 0.65, ease: "none" }, 0.35)
        .to(".p-hero-bg", { scale: 1.26, yPercent: 14, duration: 1, ease: "none", overwrite: "auto" }, 0);
    }

    if (window.ScrollTrigger) {
      gsap.from(".p-bento-card", {
        scrollTrigger: {
          trigger: ".p-bento",
          start: "top 80%",
          toggleActions: "play none none reverse",
        },
        y: 24,
        opacity: 0,
        duration: 0.95,
        stagger: 0.08,
        ease: "power3.out",
      });

      if (document.querySelector(".p-method-visual")) {
        const methodTl = gsap.timeline({
          scrollTrigger: {
            trigger: ".p-method-visual",
            start: "top 82%",
            toggleActions: "play none none reverse",
          },
        });
        methodTl
          .from(".p-method-card", {
            y: 20,
            opacity: 0,
            duration: 0.85,
            stagger: 0.1,
            ease: "power3.out",
          })
          .from(
            ".p-method-symbol",
            { opacity: 0, scale: 0.88, duration: 0.5, stagger: 0.08, ease: "power2.out" },
            "-=0.55"
          );
      }

      gsap.from(".p-step", {
        scrollTrigger: {
          trigger: ".p-stepper",
          start: "top 80%",
          toggleActions: "play none none reverse",
        },
        y: 22,
        opacity: 0,
        duration: 0.9,
        stagger: 0.1,
        ease: "power3.out",
      });

      gsap.from(".p-bridge-card", {
        scrollTrigger: {
          trigger: ".p-bridge",
          start: "top 85%",
          toggleActions: "play none none reverse",
        },
        y: 18,
        opacity: 0,
        duration: 0.85,
        stagger: 0.1,
        ease: "power3.out",
      });
    }
  }

  /* Standards section */
  const standards = document.querySelector(".p-standards");
  if (standards && window.ScrollTrigger) {
    gsap.from(".p-standards-inner", {
      scrollTrigger: { trigger: ".p-standards", start: "top 85%", toggleActions: "play none none reverse" },
      y: 18,
      opacity: 0,
      duration: 0.9,
      ease: "power3.out",
    });
    gsap.from(".p-std", {
      scrollTrigger: { trigger: ".p-standards", start: "top 85%", toggleActions: "play none none reverse" },
      y: 16,
      opacity: 0,
      duration: 0.8,
      stagger: 0.07,
      ease: "power3.out",
    });
  }

  /* TEAM (existing page) */
  const teamSection = document.querySelector(".team-section-spheres");
  if (teamSection && window.ScrollTrigger) {
    gsap.from(".section-title", {
      scrollTrigger: { trigger: teamSection, start: "top 70%" },
      y: 50,
      opacity: 0,
      duration: 1.1,
      ease: "power3.out",
    });

    gsap.to(".sphere-container", {
      y: -26,
      ease: "none",
      scrollTrigger: {
        trigger: teamSection,
        start: "top bottom",
        end: "bottom top",
        scrub: true,
      },
    });
  }

  /* PLANS (existing page) */
  if (document.querySelector(".plans-container") && window.ScrollTrigger) {
    gsap.fromTo(
      ".plan-card",
      { y: 26, opacity: 0 },
      {
        y: 0,
        opacity: 1,
        duration: 0.95,
        stagger: 0.14,
        ease: "power3.out",
        scrollTrigger: {
          trigger: ".plans-container",
          start: "top 82%",
          toggleActions: "play none none reverse",
        },
      }
    );
  }

  /* CHARTS */
  function initDareCharts() {
    if (typeof Chart === "undefined") return;
    if (!document.getElementById("progressChart") && !document.getElementById("macroChart")) return;

    Chart.defaults.color = "rgba(244, 241, 232, 0.48)";
    Chart.defaults.font.family = "'Manrope', system-ui, sans-serif";
    Chart.defaults.font.size = 11;

    const darkTooltip = {
      backgroundColor: "rgba(5, 5, 7, 0.94)",
      borderColor: "rgba(244, 241, 232, 0.12)",
      borderWidth: 1,
      padding: { x: 14, y: 10 },
      titleColor: "rgba(244, 241, 232, 0.52)",
      bodyColor: "rgba(244, 241, 232, 0.9)",
      displayColors: true,
      cornerRadius: 10,
    };

    /* Progress Line Chart */
    const progressEl = document.getElementById("progressChart");
    if (progressEl) {
      const weeks = ["Week 0", "Week 2", "Week 4", "Week 6", "Week 8", "Week 10", "Week 12"];
      new Chart(progressEl, {
        type: "line",
        data: {
          labels: weeks,
          datasets: [
            {
              label: "Body Fat %",
              data: [22.4, 21.6, 20.7, 19.8, 18.8, 18.0, 17.2],
              borderColor: "rgba(201, 162, 74, 0.92)",
              backgroundColor: "rgba(201, 162, 74, 0.08)",
              tension: 0.42,
              fill: true,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: "rgba(201, 162, 74, 0.92)",
              pointBorderColor: "rgba(5, 5, 7, 1)",
              pointBorderWidth: 2,
              yAxisID: "yFat",
            },
            {
              label: "Lean Mass Index",
              data: [64.1, 64.8, 65.6, 66.5, 67.4, 68.2, 69.2],
              borderColor: "rgba(166, 200, 94, 0.92)",
              backgroundColor: "rgba(166, 200, 94, 0.07)",
              tension: 0.42,
              fill: true,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: "rgba(166, 200, 94, 0.92)",
              pointBorderColor: "rgba(5, 5, 7, 1)",
              pointBorderWidth: 2,
              yAxisID: "yLean",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          animation: { duration: 1600, easing: "easeInOutQuart" },
          plugins: { legend: { display: false }, tooltip: darkTooltip },
          scales: {
            x: {
              grid: { color: "rgba(244, 241, 232, 0.05)" },
              border: { display: false },
              ticks: { color: "rgba(244, 241, 232, 0.38)", font: { size: 11 } },
            },
            yFat: {
              type: "linear",
              position: "left",
              grid: { color: "rgba(244, 241, 232, 0.05)" },
              border: { display: false },
              ticks: { color: "rgba(201, 162, 74, 0.70)", callback: (v) => v + "%", font: { size: 11 } },
              min: 15.5,
              max: 24,
            },
            yLean: {
              type: "linear",
              position: "right",
              grid: { display: false },
              border: { display: false },
              ticks: { color: "rgba(166, 200, 94, 0.70)", font: { size: 11 } },
              min: 62,
              max: 71,
            },
          },
        },
      });
    }

    /* Macro Bar Chart */
    const macroEl = document.getElementById("macroChart");
    if (macroEl) {
      const goals = {
        "fat-loss":    [42, 28, 30],
        "recomp":      [38, 35, 27],
        "performance": [32, 45, 23],
      };

      const macroChart = new Chart(macroEl, {
        type: "bar",
        data: {
          labels: ["Protein", "Carbohydrates", "Fat"],
          datasets: [
            {
              data: goals["fat-loss"],
              backgroundColor: [
                "rgba(166, 200, 94, 0.70)",
                "rgba(201, 162, 74, 0.70)",
                "rgba(217, 212, 200, 0.42)",
              ],
              borderColor: [
                "rgba(166, 200, 94, 0.95)",
                "rgba(201, 162, 74, 0.95)",
                "rgba(217, 212, 200, 0.62)",
              ],
              borderWidth: 1,
              borderRadius: 8,
              borderSkipped: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 650, easing: "easeInOutQuart" },
          plugins: {
            legend: { display: false },
            tooltip: {
              ...darkTooltip,
              callbacks: { label: (ctx) => "  " + ctx.raw + "% of daily calories" },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              ticks: { color: "rgba(244, 241, 232, 0.50)", font: { size: 11 } },
            },
            y: {
              grid: { color: "rgba(244, 241, 232, 0.05)" },
              border: { display: false },
              ticks: {
                color: "rgba(244, 241, 232, 0.38)",
                callback: (v) => v + "%",
                font: { size: 11 },
              },
              max: 55,
            },
          },
        },
      });

      document.querySelectorAll(".p-chart-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".p-chart-tab").forEach((t) => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          macroChart.data.datasets[0].data = goals[tab.dataset.goal];
          macroChart.update();
        });
      });
    }

    /* Weekly Protocol Chart */
    const weekEl = document.getElementById("weekChart");
    if (weekEl) {
      const protocols = {
        strength: {
          protein: [680, 660, 580, 700, 620, 680, 540],
          carbs:   [740, 500, 260, 780, 380, 700, 220],
          fat:     [360, 370, 440, 340, 390, 350, 460],
          load:    [86, 64, null, 93, 48, 81, null],
          types:   ["STRENGTH", "CARDIO", "REST", "STRENGTH", "MOBILITY", "STRENGTH", "REST"],
        },
        performance: {
          protein: [640, 700, 560, 660, 720, 620, 520],
          carbs:   [560, 860, 220, 640, 900, 760, 200],
          fat:     [350, 310, 460, 340, 300, 320, 470],
          load:    [70, 91, null, 75, 95, 88, null],
          types:   ["CARDIO", "STRENGTH", "REST", "CARDIO", "STRENGTH", "STRENGTH", "REST"],
        },
      };

      let activeWeek = "strength";

      const syncDayStripWithChart = (chart) => {
        const strip = document.querySelector('.p-week-day-strip');
        if (!strip || !chart.chartArea) return;
        strip.style.paddingLeft = chart.chartArea.left + 'px';
        strip.style.paddingRight = (chart.canvas.offsetWidth - chart.chartArea.right) + 'px';
      };

      const syncStripPlugin = {
        id: 'syncStrip',
        afterRender(chart) { syncDayStripWithChart(chart); },
      };

      const restBgPlugin = {
        id: "restBg",
        beforeDatasetsDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          const types = protocols[activeWeek].types;
          ctx.save();
          types.forEach((type, i) => {
            if (type === "REST") {
              const x = scales.x.getPixelForValue(i);
              const bw = (chartArea.right - chartArea.left) / types.length;
              ctx.fillStyle = "rgba(244, 241, 232, 0.025)";
              ctx.fillRect(x - bw / 2, chartArea.top, bw, chartArea.bottom - chartArea.top);
            }
          });
          ctx.restore();
        },
      };

      const weekChart = new Chart(weekEl, {
        data: {
          labels: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
          datasets: [
            {
              type: "bar", label: "Protein",
              data: protocols.strength.protein,
              backgroundColor: "rgba(166, 200, 94, 0.52)",
              borderColor: "rgba(166, 200, 94, 0.82)",
              borderWidth: 1, borderSkipped: false, stack: "cal",
              yAxisID: "yKcal", order: 2,
            },
            {
              type: "bar", label: "Carbohydrates",
              data: protocols.strength.carbs,
              backgroundColor: "rgba(201, 162, 74, 0.52)",
              borderColor: "rgba(201, 162, 74, 0.82)",
              borderWidth: 1, borderSkipped: false, stack: "cal",
              yAxisID: "yKcal", order: 2,
            },
            {
              type: "bar", label: "Fat",
              data: protocols.strength.fat,
              backgroundColor: "rgba(217, 212, 200, 0.26)",
              borderColor: "rgba(217, 212, 200, 0.48)",
              borderWidth: 1, borderSkipped: false, stack: "cal",
              borderRadius: { topLeft: 5, topRight: 5, bottomLeft: 0, bottomRight: 0 },
              yAxisID: "yKcal", order: 2,
            },
            {
              type: "line", label: "Training Load",
              data: protocols.strength.load,
              borderColor: "rgba(244, 241, 232, 0.75)",
              backgroundColor: "rgba(244, 241, 232, 0.04)",
              tension: 0.40, fill: true, spanGaps: false,
              pointRadius: 5, pointHoverRadius: 7,
              pointBackgroundColor: "rgba(244, 241, 232, 0.90)",
              pointBorderColor: "rgba(5, 5, 7, 1)", pointBorderWidth: 2,
              yAxisID: "yLoad", order: 1,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          animation: { duration: 900, easing: "easeInOutQuart" },
          plugins: {
            legend: { display: false },
            tooltip: {
              ...darkTooltip,
              callbacks: {
                label: (ctx) => {
                  if (ctx.dataset.label === "Training Load") {
                    return ctx.raw !== null ? `  Training Load: ${ctx.raw}%` : "  Rest Day";
                  }
                  return `  ${ctx.dataset.label}: ${ctx.raw} kcal`;
                },
                footer: (items) => {
                  const total = items.filter(i => i.dataset.yAxisID === "yKcal").reduce((s, i) => s + (i.raw || 0), 0);
                  return total > 0 ? `  Total: ${total} kcal` : "  Rest Day";
                },
              },
            },
          },
          scales: {
            x: {
              grid: { color: "rgba(244, 241, 232, 0.04)" },
              border: { display: false },
              ticks: { color: "rgba(244, 241, 232, 0.50)", font: { size: 11 } },
              stacked: true,
            },
            yKcal: {
              type: "linear", position: "left", stacked: true,
              grid: { color: "rgba(244, 241, 232, 0.05)" },
              border: { display: false },
              ticks: { color: "rgba(244, 241, 232, 0.36)", callback: (v) => v + " kcal", font: { size: 11 } },
              min: 0, max: 2200,
            },
            yLoad: {
              type: "linear", position: "right",
              grid: { display: false }, border: { display: false },
              ticks: { color: "rgba(244, 241, 232, 0.30)", callback: (v) => v + "%", font: { size: 11 } },
              min: 0, max: 130,
            },
          },
        },
        plugins: [restBgPlugin, syncStripPlugin],
      });

      document.querySelectorAll(".p-week-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".p-week-tab").forEach((t) => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          activeWeek = tab.dataset.week;
          const p = protocols[activeWeek];
          weekChart.data.datasets[0].data = p.protein;
          weekChart.data.datasets[1].data = p.carbs;
          weekChart.data.datasets[2].data = p.fat;
          weekChart.data.datasets[3].data = p.load;
          document.querySelectorAll(".p-week-day-cell").forEach((cell, i) => {
            const t = p.types[i];
            cell.textContent = t;
            cell.className = "p-week-day-cell p-day-" + t.toLowerCase();
          });
          weekChart.update();
        });
      });
    }

    /* Animate charts on scroll */
    if (window.ScrollTrigger && document.getElementById("data")) {
      gsap.from("#data .p-chart-wrap", {
        scrollTrigger: { trigger: "#data", start: "top 82%", toggleActions: "play none none none" },
        y: 22, opacity: 0, duration: 0.9, stagger: 0.12, ease: "power3.out",
      });
    }
  }

  /* Founders section animation */
  if (window.ScrollTrigger && document.getElementById("founders")) {
    gsap.from(".p-founders-quote", {
      scrollTrigger: { trigger: "#founders", start: "top 80%", toggleActions: "play none none reverse" },
      y: 18, opacity: 0, duration: 0.9, ease: "power3.out",
    });
    gsap.from(".p-founder-card", {
      scrollTrigger: { trigger: ".p-founders-grid", start: "top 82%", toggleActions: "play none none reverse" },
      y: 20, opacity: 0, duration: 0.85, stagger: 0.12, ease: "power3.out",
    });
  }

  /* Philosophy entrance */
  if (document.querySelector(".p-philosophy") && window.ScrollTrigger) {
    gsap.from(".p-philosophy-statement", {
      scrollTrigger: { trigger: ".p-philosophy", start: "top 72%", toggleActions: "play none none reverse" },
      y: 34,
      opacity: 0,
      duration: 1.15,
      ease: "power3.out",
    });
    gsap.from(".p-philosophy-sub", {
      scrollTrigger: { trigger: ".p-philosophy", start: "top 65%", toggleActions: "play none none reverse" },
      opacity: 0,
      y: 10,
      duration: 0.85,
      ease: "power2.out",
    });
  }

  /* What's included entrance */
  if (document.querySelector(".p-included") && window.ScrollTrigger) {
    gsap.from(".p-included-label", {
      scrollTrigger: { trigger: ".p-included", start: "top 85%", toggleActions: "play none none reverse" },
      opacity: 0,
      y: 10,
      duration: 0.75,
      ease: "power3.out",
    });
    gsap.from(".p-included-item", {
      scrollTrigger: { trigger: ".p-included", start: "top 82%", toggleActions: "play none none reverse" },
      opacity: 0,
      x: -16,
      duration: 0.72,
      stagger: 0.07,
      ease: "power3.out",
    });
  }

  /* 7-day timeline entrance */
  if (document.querySelector(".p-timeline") && window.ScrollTrigger) {
    gsap.from(".p-timeline-item", {
      scrollTrigger: { trigger: ".p-timeline", start: "top 80%", toggleActions: "play none none reverse" },
      opacity: 0,
      y: 22,
      duration: 0.88,
      stagger: 0.13,
      ease: "power3.out",
    });
  }

  /* Init charts — Chart.js may already be loaded or load async */
  if (typeof Chart !== "undefined") {
    initDareCharts();
  } else {
    const chartScript = document.querySelector('script[src*="chart.js"]');
    if (chartScript) chartScript.addEventListener("load", initDareCharts);
  }
});