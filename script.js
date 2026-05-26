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

    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from(".p-logo-letter", { yPercent: 120, opacity: 0, duration: 0.95, stagger: 0.06 })
      .from(".p-lead", { y: 14, opacity: 0, duration: 0.75 }, "-=0.55")
      .from(".p-cta-row .p-btn", { y: 10, opacity: 0, duration: 0.6, stagger: 0.08 }, "-=0.45")
      .from(".p-stamp-inline", { opacity: 0, y: -10, duration: 0.6 }, "-=0.65");

    if (window.ScrollTrigger) {
      const splitTl = gsap.timeline({
        scrollTrigger: {
          trigger: ".p-hero",
          start: "top top",
          end: "+=70%",
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
        .to(".p-hero-bg", { scale: 1.18, yPercent: 10, duration: 1, ease: "none", overwrite: "auto" }, 0);
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
});