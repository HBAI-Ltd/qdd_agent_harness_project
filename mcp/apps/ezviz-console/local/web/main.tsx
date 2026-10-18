import React from 'react';
import 'ezuikit-flv/style.css';
import {createRoot} from 'react-dom/client';
import Dashboard from '../../app/dashboard';
import '../../app/globals.css';
createRoot(document.getElementById('root')!).render(<Dashboard displayName="本机"/>);
