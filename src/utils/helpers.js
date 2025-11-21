export const selectRandomTheme = (availableThemes) => {
    if (!availableThemes || availableThemes.length === 0) {
      return null;
    }
    const randomIndex = Math.floor(Math.random() * availableThemes.length);
    return availableThemes[randomIndex];
  };
  
  export const sanitizeString = (str, maxLength) => {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
  };