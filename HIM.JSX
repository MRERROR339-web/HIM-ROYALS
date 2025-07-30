import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInAnonymously,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  getDocs,
  runTransaction,
  addDoc
} from 'firebase/firestore';

// Define the Firebase configuration and app ID (provided by the environment)
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Utility function for exponential backoff to handle transient network errors
const withExponentialBackoff = async (fn, retries = 5, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i < retries - 1) {
        // Log the retry attempt, but not as an error
        console.warn(`Retrying due to error: ${error.message}. Attempt ${i + 1}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      } else {
        throw error; // Re-throw if all retries fail
      }
    }
  }
};

// Wheel segments configuration: value, and relative weight for probability
const wheelSegments = [
  { value: 1, weight: 67 },  // High probability for 1 XD
  { value: 4, weight: 5 },
  { value: 13, weight: 5 },
  { value: 3, weight: 5 },
  { value: 100, weight: 5 },
  { value: 50, weight: 5 },
  { value: 13, weight: 5 },
];

// Define colors for each segment to match the provided image
const segmentColors = ['#A9A9A9', '#FF0000', '#0000FF', '#FF0000', '#0000FF', '#008000', '#FFFF00'];

// Calculate total weight for probability distribution for spin logic
const totalWeight = wheelSegments.reduce((sum, segment) => sum + segment.weight, 0);

function App() {
  // Authentication-related state variables
  const [isSignUp, setIsSignUp] = useState(true); // Toggles between Sign Up and Login forms
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [referralCodeInput, setReferralCodeInput] = useState(''); // User enters this on signup

  // Core application state variables
  const [message, setMessage] = useState(''); // User feedback messages
  const [loading, setLoading] = useState(true); // Global loading indicator
  const [user, setUser] = useState(null); // Firebase authenticated user object
  const [db, setDb] = useState(null); // Firestore instance
  const [auth, setAuth] = useState(null); // Firebase Auth instance
  const [userId, setUserId] = useState(null); // Current user's UID (for Firestore paths)
  const [userProfile, setUserProfile] = useState(null); // User's profile data from Firestore

  // Game-specific state variables
  const [currentView, setCurrentView] = useState('spin'); // Controls which main section is displayed
  const [userXD, setUserXD] = useState(0); // Current user's XD balance
  const [referralCode, setReferralCode] = useState(''); // Current user's own referral code to share

  // Notification system states
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);

  // Spin Wheel specific states
  const [isSpinning, setIsSpinning] = useState(false);
  const [wheelRotation, setWheelRotation] = useState(0); // CSS transform rotation for the wheel
  const canvasRef = useRef(null); // Reference to the canvas DOM element

  // Withdrawal specific states
  const [withdrawAmountRBX, setWithdrawAmountRBX] = useState('');
  const [robloxUsername, setRobloxUsername] = useState('');
  const [remarks, setRemarks] = useState('');

  // --- Firebase Initialization and Authentication Listener ---
  useEffect(() => {
    const initializeFirebase = async () => {
      try {
        const app = initializeApp(firebaseConfig);
        const authInstance = getAuth(app);
        const dbInstance = getFirestore(app);

        setAuth(authInstance);
        setDb(dbInstance);

        // Attempt to sign in with a custom token (provided by the environment)
        // If no custom token, sign in anonymously to allow data persistence
        if (initialAuthToken) {
          await withExponentialBackoff(() => signInWithCustomToken(authInstance, initialAuthToken));
        } else {
          await withExponentialBackoff(() => signInAnonymously(authInstance));
        }

        // Set up an authentication state change listener
        // This ensures user state and profile data are always up-to-date
        onAuthStateChanged(authInstance, async (currentUser) => {
          setUser(currentUser);
          if (currentUser) {
            setUserId(currentUser.uid);
            // Fetch or create user profile in Firestore
            await fetchOrCreateUserProfile(dbInstance, currentUser.uid, currentUser.email);
          } else {
            // Clear user-specific data if logged out
            setUserId(null);
            setUserProfile(null);
            setUserXD(0);
            setReferralCode('');
          }
          setLoading(false); // Stop global loading after initial auth check
        });
      } catch (error) {
        setMessage(`Error initializing Firebase: ${error.message}`);
        console.error("Firebase initialization error:", error);
        setLoading(false);
      }
    };

    initializeFirebase();
  }, []); // Empty dependency array ensures this runs only once on component mount

  // --- Fetch or Create User Profile in Firestore ---
  const fetchOrCreateUserProfile = async (dbInstance, uid, email) => {
    if (!dbInstance || !uid) return;
    try {
      // Document reference for the user's private profile data
      const userDocRef = doc(dbInstance, `artifacts/${appId}/users/${uid}/user_profiles`, uid);
      const docSnap = await withExponentialBackoff(() => getDoc(userDocRef));

      if (docSnap.exists()) {
        // If profile exists, load it
        const data = docSnap.data();
        setUserProfile(data);
        setUserXD(data.xdBalance || 0);
        setReferralCode(data.referralCode || '');
      } else {
        // If profile doesn't exist (new user or first anonymous visit), create a default one
        const newReferralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        const defaultUsername = email ? email.split('@')[0] : `Guest_${uid.substring(0, 6)}`;

        await withExponentialBackoff(() =>
          setDoc(userDocRef, {
            email: email || 'anonymous@example.com', // Store placeholder for anonymous
            username: defaultUsername,
            referralLink: '', // The referral code this user *used* to sign up (if any)
            referralCode: newReferralCode, // This user's *own* unique code to share
            xdBalance: 0, // Initialize XD balance
            createdAt: new Date().toISOString()
          })
        );
        // Re-fetch the newly created profile to ensure state is updated
        const updatedDocSnap = await withExponentialBackoff(() => getDoc(userDocRef));
        if (updatedDocSnap.exists()) {
          const updatedData = updatedDocSnap.data();
          setUserProfile(updatedData);
          setUserXD(updatedData.xdBalance || 0);
          setReferralCode(updatedData.referralCode || '');
        }
      }
    } catch (error) {
      setMessage(`Error fetching/creating user profile: ${error.message}`);
      console.error("Error fetching/creating user profile:", error);
    }
  };

  // --- Canvas Drawing Logic for Spin Wheel ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Function to set canvas dimensions and redraw the wheel
    const setCanvasDimensions = () => {
      // Ensure canvas matches its parent's size for responsiveness
      const size = Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight);
      canvas.width = size;
      canvas.height = size;
      drawWheel();
    };

    // Function to draw all segments and their text on the wheel
    const drawWheel = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear previous drawings
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = Math.min(centerX, centerY) * 0.9; // Wheel radius, with padding

      let startAngle = 0;
      // Calculate total weight for drawing proportion (should be same as `totalWeight` global)
      const totalWeightForDrawing = wheelSegments.reduce((sum, segment) => sum + segment.weight, 0);

      wheelSegments.forEach((segment, index) => {
        // Calculate angle for each segment based on its relative weight
        const segmentAngleRad = (segment.weight / totalWeightForDrawing) * (2 * Math.PI);
        const endAngle = startAngle + segmentAngleRad;

        // Draw segment (pie slice)
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = segmentColors[index % segmentColors.length]; // Apply predefined color
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw text for the segment
        ctx.save(); // Save current canvas state
        ctx.translate(centerX, centerY); // Move origin to center of wheel
        
        // Calculate the middle angle of the current segment
        const textAngle = startAngle + segmentAngleRad / 2;
        // Rotate the canvas context so text is oriented along the segment's radius
        // Add PI/2 (90 degrees) to orient text upright when segment is on the right
        ctx.rotate(textAngle + Math.PI / 2); 
        
        ctx.textAlign = 'center'; // Center text horizontally
        ctx.textBaseline = 'middle'; // Center text vertically
        
        // Determine text color for contrast based on segment background
        ctx.fillStyle = (segmentColors[index % segmentColors.length] === '#FFFF00' || segmentColors[index % segmentColors.length] === '#A9A9A9' || segmentColors[index % segmentColors.length] === '#008000') ? 'black' : 'white';
        ctx.font = 'bold 20px Arial';
        
        // Position text radially outwards from the center. Y-coordinate is negative
        // because of the 90-degree rotation applied to the context.
        ctx.fillText(`${segment.value} XD`, 0, -radius * 0.65); // 0.65 adjusts distance from center
        ctx.restore(); // Restore canvas state to prevent accumulated rotations

        startAngle = endAngle; // Prepare for the next segment
      });

      // Draw the central white circle
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 0.15, 0, 2 * Math.PI);
      ctx.fillStyle = 'white'; // White color for the center circle
      ctx.fill();
      ctx.strokeStyle = 'gray';
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // Initial drawing when component mounts
    setCanvasDimensions();

    // Set up ResizeObserver to redraw wheel when container size changes
    const resizeObserver = new ResizeObserver(() => {
      setCanvasDimensions();
    });
    resizeObserver.observe(canvas.parentElement); // Observe the parent div

    // Cleanup function for useEffect
    return () => {
      resizeObserver.disconnect(); // Disconnect observer when component unmounts
    };
  }, [wheelSegments, wheelRotation]); // Redraw if segments data or rotation changes

  // --- Notification System ---
  const addNotification = (text) => {
    setNotifications(prev => [...prev, { id: Date.now(), text }]);
    setShowNotifications(true);
    // Automatically remove notification after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.text !== text));
    }, 5000);
  };

  // --- Authentication Handlers ---
  const handleSignUp = async (e) => {
    e.preventDefault(); // Prevent default form submission
    setLoading(true);
    setMessage('');

    if (!auth || !db) {
      setMessage('Firebase not initialized. Please try again later.');
      setLoading(false);
      return;
    }

    try {
      // Create user with Firebase Authentication
      const userCredential = await withExponentialBackoff(() =>
        createUserWithEmailAndPassword(auth, email, password)
      );
      const newUser = userCredential.user;

      const newReferralCode = Math.random().toString(36).substring(2, 10).toUpperCase(); // Generate unique code

      let referrerUid = null;
      if (referralCodeInput) {
        // Attempt to find the referrer's UID using the provided referral code
        // This client-side lookup is inefficient for many users.
        // A dedicated Firestore collection for referral codes (e.g., /referral_codes/{code} -> {uid})
        // or a Cloud Function for lookup would be more scalable and secure.
        const usersCollectionRef = collection(db, `artifacts/${appId}/users`);
        const allUsersSnapshot = await withExponentialBackoff(() => getDocs(usersCollectionRef));
        
        // Iterate through all user profiles to find a matching referral code
        for (const userDoc of allUsersSnapshot.docs) {
          const userProfileDocRef = doc(db, `artifacts/${appId}/users/${userDoc.id}/user_profiles`, userDoc.id);
          const userProfileSnap = await withExponentialBackoff(() => getDoc(userProfileDocRef));
          if (userProfileSnap.exists() && userProfileSnap.data().referralCode === referralCodeInput.toUpperCase()) {
            referrerUid = userDoc.id;
            break;
          }
        }

        if (!referrerUid) {
          setMessage('Invalid referral code entered. Account created without referral bonus link.');
        }
      }

      // Save new user's profile data to Firestore
      const userDocRef = doc(db, `artifacts/${appId}/users/${newUser.uid}/user_profiles`, newUser.uid);
      await withExponentialBackoff(() =>
        setDoc(userDocRef, {
          email: newUser.email,
          username: username,
          referralLinkUsed: referralCodeInput, // The code this user used to sign up
          referralCode: newReferralCode, // This user's own code to share
          xdBalance: 0, // Initialize XD balance to 0
          createdAt: new Date().toISOString(),
          referrerUid: referrerUid // Store the UID of the referrer if found
        })
      );

      setMessage('Account created successfully! You are now logged in.');
      setEmail('');
      setPassword('');
      setUsername('');
      setReferralCodeInput('');
      setUser(newUser);
      setUserId(newUser.uid);
      await fetchOrCreateUserProfile(db, newUser.uid, newUser.email); // Update local state with new profile
    } catch (error) {
      let errorMessage = 'Failed to create account. Please try again.';
      if (error.code === 'auth/email-already-in-use') {
        errorMessage = 'This email is already registered. Please login or use a different email.';
      } else if (error.code === 'auth/weak-password') {
        errorMessage = 'Password should be at least 6 characters.';
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Invalid email address.';
      }
      setMessage(errorMessage);
      console.error("Sign Up Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault(); // Prevent default form submission
    setLoading(true);
    setMessage('');

    if (!auth || !db) {
      setMessage('Firebase not initialized. Please try again later.');
      setLoading(false);
      return;
    }

    try {
      // Sign in user with Firebase Authentication
      const userCredential = await withExponentialBackoff(() =>
        signInWithEmailAndPassword(auth, email, password)
      );
      const loggedInUser = userCredential.user;

      setMessage('Logged in successfully!');
      setEmail('');
      setPassword('');
      setUser(loggedInUser);
      setUserId(loggedInUser.uid);
      await fetchOrCreateUserProfile(db, loggedInUser.uid, loggedInUser.email); // Fetch user profile
    } catch (error) {
      let errorMessage = 'Login failed. Please check your email and password.';
      if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
        errorMessage = 'Invalid email or password.';
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Invalid email address.';
      }
      setMessage(errorMessage);
      console.error("Login Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    setMessage('');
    if (!auth) {
      setMessage('Firebase not initialized.');
      setLoading(false);
      return;
    }
    try {
      await withExponentialBackoff(() => signOut(auth));
      setMessage('Logged out successfully.');
      // Clear all user-specific state
      setUser(null);
      setUserId(null);
      setUserProfile(null);
      setUserXD(0);
      setReferralCode('');
      setCurrentView('spin'); // Reset view to spin
      setIsSignUp(true); // Go back to signup view by default
    } catch (error) {
      setMessage(`Logout failed: ${error.message}`);
      console.error("Logout Error:", error);
    } finally {
      setLoading(false);
    }
  };

  // --- Spin Wheel Logic ---
  const spinWheel = async () => {
    // Prevent spinning if already spinning, DB/user not ready, or loading
    if (isSpinning || !db || !userId || loading) {
      setMessage("Please wait or ensure the app is fully loaded before spinning.");
      return;
    }

    setIsSpinning(true);
    setMessage('');

    // Determine the winning segment based on probability weights
    let randomNumber = Math.random() * totalWeight;
    let winningSegment = null;
    let cumulativeWeight = 0;
    for (const segment of wheelSegments) {
      cumulativeWeight += segment.weight;
      if (randomNumber <= cumulativeWeight) {
        winningSegment = segment;
        break;
      }
    }

    // Fallback in case a segment isn't selected (shouldn't happen with correct weights)
    if (!winningSegment) {
      winningSegment = wheelSegments[0];
    }

    const totalSegments = wheelSegments.length;
    // Calculate the angle each segment occupies based on its weight for visual rotation
    const totalWeightForRotation = wheelSegments.reduce((sum, segment) => sum + segment.weight, 0);
    
    // Calculate the target rotation for the wheel
    let targetRotationDegrees = 0;
    let currentCumulativeAngle = 0;
    for (let i = 0; i < wheelSegments.length; i++) {
        const segmentAngleDegrees = (wheelSegments[i].weight / totalWeightForRotation) * 360;
        if (wheelSegments[i] === winningSegment) {
            // Target the middle of the winning segment
            targetRotationDegrees = currentCumulativeAngle + (segmentAngleDegrees / 2);
            break;
        }
        currentCumulativeAngle += segmentAngleDegrees;
    }

    // The pointer is visually at the right (0 degrees). We want the winning segment's center to align with the pointer.
    // So, we need to rotate the wheel such that the winning segment's center moves to 0 degrees.
    let rotationToAlign = (360 - targetRotationDegrees) % 360;

    // Add multiple full rotations for a visually appealing spin effect
    const fullSpins = 5; 
    // Ensure the wheel always spins forward from its current position
    const currentNormalizedRotation = wheelRotation % 360;
    let finalRotation = currentNormalizedRotation + (fullSpins * 360) + rotationToAlign;

    // If for some reason the calculated final rotation is less than current + full spins,
    // add another full rotation to ensure forward movement.
    if (finalRotation < currentNormalizedRotation + (fullSpins * 360)) {
        finalRotation += 360;
    }

    setWheelRotation(finalRotation);

    // After the spin animation finishes (duration matches CSS transition)
    setTimeout(async () => {
      setIsSpinning(false);
      const userDocRef = doc(db, `artifacts/${appId}/users/${userId}/user_profiles`, userId);
      try {
        // Use a Firestore transaction for atomic update of XD balance
        await runTransaction(db, async (transaction) => {
          const userDoc = await transaction.get(userDocRef);
          if (!userDoc.exists()) {
            throw "User profile does not exist!"; // Should not happen if user is authenticated
          }
          const currentXD = userDoc.data().xdBalance || 0;
          const newXD = currentXD + winningSegment.value;
          transaction.update(userDocRef, { xdBalance: newXD });
          setUserXD(newXD); // Update local React state
          addNotification(`You won ${winningSegment.value} XD!`);
          setMessage(`You won ${winningSegment.value} XD! Your new balance is ${newXD} XD.`);
        });
      } catch (error) {
        setMessage(`Error updating XD balance: ${error.message}`);
        console.error("Error updating XD balance:", error);
      }
    }, 3000); // 3 seconds matches the CSS transition duration
  };

  // --- Withdrawal Logic ---
  const handleWithdraw = async (e) => {
    e.preventDefault(); // Prevent default form submission
    setLoading(true);
    setMessage('');

    const amountRBX = parseFloat(withdrawAmountRBX);
    const amountXD = amountRBX * 100; // Conversion: 1 RBX = 100 XD

    // Input validation
    if (isNaN(amountRBX) || amountRBX <= 0) {
      setMessage('Please enter a valid amount.');
      setLoading(false);
      return;
    }
    if (amountRBX < 7) {
      setMessage('Minimum withdrawal amount is 7 RBX.');
      setLoading(false);
      return;
    }
    if (amountRBX > 10000) {
      setMessage('Maximum withdrawal amount is 10,000 RBX.');
      setLoading(false);
      return;
    }
    if (amountXD > userXD) {
      setMessage('Insufficient XD balance.');
      setLoading(false);
      return;
    }
    if (!robloxUsername.trim()) {
      setMessage('Please enter your Roblox username.');
      setLoading(false);
      return;
    }

    if (!db || !userId || !userProfile) {
      setMessage('Application not fully loaded or user not authenticated.');
      setLoading(false);
      return;
    }

    const userDocRef = doc(db, `artifacts/${appId}/users/${userId}/user_profiles`, userId);

    try {
      // Use a Firestore transaction for atomic withdrawal and pending bonus creation
      await runTransaction(db, async (transaction) => {
        const userDoc = await transaction.get(userDocRef);
        if (!userDoc.exists()) {
          throw "User profile does not exist!";
        }
        const currentXD = userDoc.data().xdBalance || 0;

        if (currentXD < amountXD) {
          throw new Error("Insufficient XD balance for withdrawal.");
        }

        const newXD = currentXD - amountXD;
        // Update user's XD balance and store withdrawal details
        transaction.update(userDocRef, {
          xdBalance: newXD,
          robloxUsername: robloxUsername,
          lastWithdrawal: new Date().toISOString(),
          withdrawalAmountRBX: amountRBX,
          withdrawalRemarks: remarks
        });
        setUserXD(newXD); // Update local state

        // --- Referral Bonus Logic (Creates a PENDING record for backend processing) ---
        // Check if the current user (referee) has a referrer
        if (userProfile.referrerUid) {
          const bonusAmountXD = amountXD * 0.10; // 10% of redeemed XD
          // Create a document in a public collection for a backend service to process
          const pendingBonusCollectionRef = collection(db, `artifacts/${appId}/public/data/pending_referral_bonuses`);
          
          await addDoc(pendingBonusCollectionRef, {
            referrerUid: userProfile.referrerUid, // The UID of the user who referred this user
            refereeUid: userId, // The UID of the user who is withdrawing
            amountRedeemedXD: amountXD,
            bonusAmountXD: bonusAmountXD,
            timestamp: new Date().toISOString(),
            status: 'pending' // Status to be updated by a backend service
          });
          addNotification(`Referral bonus of ${bonusAmountXD} XD pending for your referrer!`);
        }
        // --- End Referral Bonus Logic ---

        addNotification(`Withdrawal request for ${amountRBX} RBX submitted!`);
        setMessage(`Withdrawal request for ${amountRBX} RBX submitted. Your new balance is ${newXD} XD.`);
        
        // Clear withdrawal form fields
        setWithdrawAmountRBX('');
        setRobloxUsername('');
        setRemarks('');
      });
    } catch (error) {
      setMessage(`Withdrawal failed: ${error.message}`);
      console.error("Withdrawal Error:", error);
    } finally {
      setLoading(false);
    }
  };

  // Render a loading screen if Firebase is still initializing or user not loaded
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4 font-sans">
        <div className="text-white text-2xl">Loading application...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4 font-sans">
      <div className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-2xl transform transition-all duration-300 hover:scale-105 relative">
        {user ? ( // If a user (authenticated or anonymous) is present
          <>
            {/* Balance Display */}
            <div className="absolute top-4 right-4 text-gray-800 font-bold text-lg bg-blue-100 px-4 py-2 rounded-lg shadow-md">
              Balance: {userXD} XD
            </div>
            {/* Referral Code Display */}
            <div className="absolute bottom-4 right-4 text-gray-600 text-sm bg-gray-100 px-3 py-1 rounded-lg shadow-sm">
              Referral Code: {referralCode || 'N/A'}
            </div>
            {/* Notification Button */}
            <div className="absolute top-4 left-4">
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="bg-yellow-500 text-white p-3 rounded-full shadow-lg hover:bg-yellow-600 transition duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-400"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                  />
                </svg>
                {notifications.length > 0 && (
                  <span className="absolute top-0 right-0 inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-red-100 bg-red-600 rounded-full transform translate-x-1/2 -translate-y-1/2">
                    {notifications.length}
                  </span>
                )}
              </button>
              {showNotifications && (
                <div className="absolute z-10 bg-white border border-gray-200 rounded-lg shadow-xl mt-2 w-64 max-h-60 overflow-y-auto">
                  <h3 className="font-bold text-gray-800 p-3 border-b">Notifications</h3>
                  {notifications.length === 0 ? (
                    <p className="p-3 text-gray-500">No new notifications.</p>
                  ) : (
                    <ul>
                      {notifications.map((n) => (
                        <li key={n.id} className="p-3 text-gray-700 border-b last:border-b-0">
                          {n.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <h1 className="text-3xl font-extrabold text-center text-gray-800 mb-6">
              Welcome, {userProfile?.username || user.email || 'Guest'}!
            </h1>
            <p className="text-sm text-gray-600 text-center mb-4 break-all">Your User ID: {userId}</p>


            <div className="flex justify-center mb-6 space-x-4">
              <button
                onClick={() => setCurrentView('spin')}
                className={`py-3 px-8 rounded-lg text-lg font-bold transition-all duration-300 shadow-md ${
                  currentView === 'spin'
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Spin
              </button>
              <button
                onClick={() => setCurrentView('withdraw')}
                className={`py-3 px-8 rounded-lg text-lg font-bold transition-all duration-300 shadow-md ${
                  currentView === 'withdraw'
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Withdraw
              </button>
            </div>

            {message && (
              <div
                className={`p-3 mb-4 rounded-lg text-center font-medium ${
                  message.includes('success') || message.includes('won') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}
              >
                {message}
              </div>
            )}

            {currentView === 'spin' && (
              <div className="text-center">
                <div className="relative w-64 h-64 mx-auto mb-8">
                  {/* Canvas element for the spin wheel */}
                  <canvas
                    ref={canvasRef}
                    width="256" // Initial width for drawing buffer
                    height="256" // Initial height for drawing buffer
                    className="absolute inset-0 rounded-full"
                    style={{
                      transform: `rotate(${wheelRotation}deg)`,
                      transition: isSpinning ? 'transform 3s ease-out' : 'none',
                      border: '8px solid #d1d5db', // Matching the previous border style
                    }}
                  ></canvas>
                  {/* Pointer (positioned on the right) */}
                  <div className="absolute top-1/2 right-0 -translate-y-1/2 translate-x-full w-0 h-0 border-t-[15px] border-t-transparent border-b-[15px] border-b-transparent border-l-[30px] border-l-red-600 z-10"></div>
                </div>
                <button
                  onClick={spinWheel}
                  className="w-full bg-blue-600 text-white py-4 px-6 rounded-full hover:bg-blue-700 transition duration-300 ease-in-out font-bold text-xl shadow-lg hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transform active:scale-95"
                  disabled={isSpinning || loading}
                >
                  {isSpinning ? 'Spinning...' : 'Spin the Wheel!'}
                </button>
              </div>
            )}

            {currentView === 'withdraw' && (
              <div className="text-center">
                <p className="text-md font-semibold text-red-600 mb-6 bg-red-100 p-3 rounded-lg border border-red-200">
                  NOTE: PLEASE CREATE A GAMEPASS IN PLS DONATE OF 40% MORE RBX THEN YOUR AMOUNT BECAUSE IT WILL BE DEDUCTED.
                </p>
                <form onSubmit={handleWithdraw} className="space-y-4">
                  <div>
                    <label htmlFor="withdraw-amount" className="block text-gray-700 text-sm font-bold mb-2">
                      Enter Amount (RBX)
                    </label>
                    <input
                      type="number"
                      id="withdraw-amount"
                      className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                      placeholder="e.g., 7 (Min 7 RBX, Max 10,000 RBX)"
                      value={withdrawAmountRBX}
                      onChange={(e) => setWithdrawAmountRBX(e.target.value)}
                      min="7"
                      max="10000"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="roblox-username" className="block text-gray-700 text-sm font-bold mb-2">
                      Enter Roblox Username
                    </label>
                    <input
                      type="text"
                      id="roblox-username"
                      className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                      placeholder="Your Roblox username"
                      value={robloxUsername}
                      onChange={(e) => setRobloxUsername(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="remarks" className="block text-gray-700 text-sm font-bold mb-2">
                      Remarks (Optional)
                    </label>
                    <textarea
                      id="remarks"
                      className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                      placeholder="Any specific notes for your withdrawal"
                      rows="3"
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                    ></textarea>
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 transition duration-300 ease-in-out font-bold text-lg shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
                    disabled={loading}
                  >
                    {loading ? 'Processing...' : 'Withdraw'}
                  </button>
                </form>
              </div>
            )}

            <button
              onClick={handleLogout}
              className="mt-8 w-full bg-red-600 text-white py-3 px-4 rounded-lg hover:bg-red-700 transition duration-300 ease-in-out font-bold text-lg shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
              disabled={loading}
            >
              {loading ? 'Logging Out...' : 'Logout'}
            </button>
          </>
        ) : ( // If no user (not authenticated or anonymous)
          <>
            <div className="flex justify-center mb-6">
              <button
                onClick={() => setIsSignUp(true)}
                className={`py-2 px-6 rounded-l-lg text-lg font-semibold transition-all duration-300 ${
                  isSignUp
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Sign Up
              </button>
              <button
                onClick={() => setIsSignUp(false)}
                className={`py-2 px-6 rounded-r-lg text-lg font-semibold transition-all duration-300 ${
                  !isSignUp
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Login
              </button>
            </div>

            {message && (
              <div
                className={`p-3 mb-4 rounded-lg text-center font-medium ${
                  message.includes('success') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}
              >
                {message}
              </div>
            )}

            {isSignUp ? (
              // Sign Up Form
              <form onSubmit={handleSignUp} className="space-y-4">
                <div>
                  <label htmlFor="email-signup" className="block text-gray-700 text-sm font-bold mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email-signup"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="username-signup" className="block text-gray-700 text-sm font-bold mb-2">
                    Username
                  </label>
                  <input
                    type="text"
                    id="username-signup"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Choose a username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="password-signup" className="block text-gray-700 text-sm font-bold mb-2">
                    Password
                  </label>
                  <input
                    type="password"
                    id="password-signup"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Create a password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="referral-code-input" className="block text-gray-700 text-sm font-bold mb-2">
                    Referral Code (Optional)
                  </label>
                  <input
                    type="text"
                    id="referral-code-input"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Enter referrer's code"
                    value={referralCodeInput}
                    onChange={(e) => setReferralCodeInput(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition duration-300 ease-in-out font-bold text-lg shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
                  disabled={loading}
                >
                  {loading ? 'Creating Account...' : 'Create Account'}
                </button>
              </form>
            ) : (
              // Login Form
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label htmlFor="email-login" className="block text-gray-700 text-sm font-bold mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email-login"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="password-login" className="block text-gray-700 text-sm font-bold mb-2">
                    Password
                  </label>
                  <input
                    type="password"
                    id="password-login"
                    className="shadow-sm appearance-none border rounded-lg w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition duration-300 ease-in-out font-bold text-lg shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
                  disabled={loading}
                >
                  {loading ? 'Logging In...' : 'Login'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
