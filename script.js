document.addEventListener("DOMContentLoaded", () => {
    gsap.registerPlugin(ScrollTrigger);

    /* =========================================
       1. LÓGICA DEL MENÚ
       ========================================= */
    const menuBtn = document.getElementById('menu-btn');
    const fullMenu = document.getElementById('full-menu');
    const menuLinks = document.querySelectorAll('.menu-item a');

    if (menuBtn && fullMenu) {
        menuBtn.addEventListener('click', () => {
            const isOpen = menuBtn.classList.toggle('active');
            fullMenu.classList.toggle('active');

            if (isOpen) {
                gsap.to(menuLinks, {
                    opacity: 1, y: 0, duration: 0.8, stagger: 0.1, ease: "power4.out", delay: 0.4
                });
                gsap.to(".menu-footer", { opacity: 1, delay: 0.8 });
            } else {
                gsap.to(menuLinks, { opacity: 0, y: 20, duration: 0.3, stagger: 0.05 });
                gsap.to(".menu-footer", { opacity: 0, duration: 0.2 });
            }
        });
    } // <--- AQUÍ ESTABA EL ERROR (Antes tenías "});")

    menuLinks.forEach(link => {
        link.addEventListener('click', () => {
            if (menuBtn) menuBtn.classList.remove('active');
            if (fullMenu) fullMenu.classList.remove('active');
            gsap.to(menuLinks, { opacity: 0, y: 20 });
        });
    });
    

    /* =========================================
       2. HEADER Y LOGO HERO (EFECTO SPLIT + ROTATE)
       ========================================= */
    window.addEventListener("scroll", () => {
        const logoContainer = document.querySelector("#hero-title");
        const partLeft = document.querySelector(".logo-part.left");
        const partRight = document.querySelector(".logo-part.right");
        const header = document.querySelector(".header-main");
        
        const scrollY = window.scrollY;
        const maxScroll = 500; 
        let progress = Math.min(scrollY / maxScroll, 1);

        if (logoContainer && partLeft && partRight) {
            const scaleValue = 1 + (progress * 2.5); 
            const opacityValue = 1 - progress;
            
            logoContainer.style.transform = `scale(${scaleValue})`;
            logoContainer.style.opacity = opacityValue;
            logoContainer.style.pointerEvents = opacityValue <= 0 ? "none" : "auto";

            const gapValue = progress * 300; 
            const rotateValue = progress * 180; 

            partLeft.style.transform = `translateX(-${gapValue}px) rotate(-${rotateValue}deg)`;
            partRight.style.transform = `translateX(${gapValue}px) rotate(${rotateValue}deg)`;
        }

        if (header) {
            if (scrollY > 50) {
                header.classList.add("scrolled");
            } else {
                header.classList.remove("scrolled");
            }
        }
    });

    /* =========================================
       3. ANIMACIONES HOME (GSAP PINNING)
       ========================================= */
    if (document.querySelector(".hero-section")) {
        let tlHero = gsap.timeline({
            scrollTrigger: {
                trigger: ".hero-section",
                start: "top top",
                end: "+=100%",
                pin: true,
                scrub: true
            }
        });
        tlHero.to("#black-overlay", { opacity: 1, ease: "none" });

        gsap.fromTo("#invasion-text .line-inner-text", 
            { x: 100, opacity: 0 },
            {
                x: 0, opacity: 1, duration: 1.2, ease: "power4.out", stagger: 0.1, 
                scrollTrigger: {
                    trigger: "#invasion-text",
                    start: "top 80%",
                    toggleActions: "play none none reverse"
                }
            }
        );

        gsap.to(".line-inner", {
            y: 0, opacity: 1, duration: 1.4, ease: "power3.out", stagger: 0.1, 
            scrollTrigger: {
                trigger: "#invasion-description",
                start: "top 85%",
                toggleActions: "play none none reverse"
            }
        });
    }

    /* =========================================
       4. ENERGY PULSE & FORMULA
       ========================================= */
    gsap.utils.toArray(".energy-pulse-section").forEach((section) => {
        const waves = section.querySelectorAll(".pulse-wave");
        gsap.to(waves, {
            strokeDashoffset: 0, duration: 1.0, ease: "expo.out", stagger: 0.4,
            scrollTrigger: { trigger: section, start: "top 90%", toggleActions: "play none none reverse" }
        });
    });

    if (document.querySelector(".method-formula-section")) {
        gsap.utils.toArray(".formula-row").forEach((row) => {
            gsap.from(row, {
                scrollTrigger: { trigger: row, start: "top 85%", toggleActions: "play none none reverse" },
                y: 50, opacity: 0, duration: 1.2, ease: "power3.out"
            });
        });
    }

    /* =========================================
       5. TEAM SECTION (NUEVO DISEÑO: ENERGY SPHERES)
       ========================================= */
    const teamSection = document.querySelector(".team-section-spheres");
    
    if (teamSection) {
        // A) Animar Título de Sección
        gsap.from(".section-title", {
            scrollTrigger: {
                trigger: teamSection,
                start: "top 70%",
            },
            y: 50,
            opacity: 0,
            duration: 1.2,
            ease: "power3.out"
        });

        // B) Timeline principal para las esferas
        const leftSphere = document.querySelector(".left-sphere");
        const rightSphere = document.querySelector(".right-sphere");
        const energyCenter = document.querySelector(".energy-field-center");

        const spheresTl = gsap.timeline({
            scrollTrigger: {
                trigger: ".synergy-field-container",
                start: "top 75%", 
                end: "bottom bottom",
                toggleActions: "play none none reverse"
            }
        });

        if(leftSphere && rightSphere && energyCenter) {
            spheresTl
            // El centro se enciende primero
            .to(energyCenter, { opacity: 1, duration: 0.5 })
            .from(energyCenter.querySelector(".energy-glow-bar"), { scaleX: 0, duration: 1, ease: "expo.out" }, "<")
            
            // Las esferas entran desde los lados rotando ligeramente
            .from(leftSphere, { x: -100, rotation: -15, opacity: 0, duration: 1.2, ease: "back.out(1.7)" }, "-=0.5")
            .from(rightSphere, { x: 100, rotation: 15, opacity: 0, duration: 1.2, ease: "back.out(1.7)" }, "<");
        }

        // C) Efecto Parallax suave en las esferas para que floten
        gsap.to(".sphere-container", {
            y: -30, // Se mueven hacia arriba sutilmente al hacer scroll
            ease: "none",
            scrollTrigger: {
                trigger: teamSection,
                start: "top bottom",
                end: "bottom top",
                scrub: true
            }
        });
    }

/* =========================================
       6. PLANES (ANIMACIÓN DE ENTRADA)
       ========================================= */
    if (document.querySelector(".plans-container")) {
        // Animamos las tarjetas para que suban y aparezcan
        gsap.to(".plan-card", {
            y: 0, 
            opacity: 1, 
            duration: 1, 
            stagger: 0.2, // Retraso entre cada tarjeta (0.2s)
            ease: "power3.out",
            scrollTrigger: { 
                trigger: ".plans-container", 
                start: "top 80%", // Empieza cuando el top del container está al 80% de la pantalla
                toggleActions: "play none none reverse"
            }
        });
    }

}); // CIERRE FINAL CORRECTO DEL DOMCONTENTLOADED